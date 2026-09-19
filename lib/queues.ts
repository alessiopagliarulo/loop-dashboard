/**
 * Shared server-side helpers and types for the Ideas queue (/ideas) and the
 * Builds & Evidence station (/builds).
 *
 * These extend lib/github.ts (which we must not edit) by calling getOctokit()
 * directly for the endpoints the base helpers don't expose: issue-comment
 * listing, PR details/files, and PR closing. Everything here runs on the
 * server (API routes / server components) where GITHUB_TOKEN is available.
 */

import { getOctokit, type RepoConfig } from "@/lib/github";
import { loadEvidenceManifest, readEvidenceFile } from "@/lib/queues-evidence";
import {
  findQueueDuplicates,
  primeDuplicateIndex,
  type DuplicateReport,
} from "@/lib/dedup/queue-duplicates";
import { COVERED_LABEL, latestCoverLinks, type CoverLink } from "@/lib/idea-coverage";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** A Scout proposal / idea (a GitHub issue that is not a PR). */
export type IdeaSummary = {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  labels: string[];
  author: string;
  authorAvatar: string;
  state: "open" | "closed";
  closedAt: string | null;
  stateReason: string | null;
  /**
   * For a live idea flagged `covered`: what already covers it, read from the loop's
   * covered comment (see lib/idea-coverage.ts). An empty list means the flag is on
   * but its links could not be read; absent on every idea without the flag.
   */
  coveredBy?: CoverLink[];
};

/** The four Ideas tabs, each with its issues. */
export type IdeasPayload = {
  waiting: IdeaSummary[]; // proposal
  approved: IdeaSummary[]; // approved
  redraft: IdeaSummary[]; // redraft
  closed: IdeaSummary[]; // recently closed that carried one of the idea labels
  /**
   * Near-duplicate pairs within the four tabs above, from the embedding index
   * in `lib/dedup/`. Decoration, never a precondition: `null` whenever the
   * index is unavailable, stale, or scoped to a different repo, and the screen
   * renders exactly as it did before this field existed.
   */
  duplicates: DuplicateReport | null;
};

/** A single comment on an issue or PR. */
export type ThreadComment = {
  id: number;
  author: string;
  authorAvatar: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
  isBot: boolean;
};

/** Lightweight PR row for the Builds tabs. */
export type PRSummary = {
  number: number;
  title: string;
  headRef: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  state: "open" | "closed";
  merged: boolean;
  author: string;
  authorAvatar: string;
  draft: boolean;
};

/** The three Builds tabs. */
export type BuildsPayload = {
  needsReview: PRSummary[]; // open PRs from claude/** branches (drafts included)
  merged: PRSummary[]; // recently merged
  closed: PRSummary[]; // recently closed without merging
  /**
   * Open non-draft `claude/` PRs — the number the Builder counts against
   * `prCap` when it decides whether it has room for another build. Drafts are
   * still shown in `needsReview` (flagged by `draft`) but, like the Builder,
   * they are NOT counted here: showing a free slot the Builder doesn't agree
   * exists is what made the queue look open while it stood down.
   */
  capCount: number;
};

export type VerdictLevel = "SHIP" | "FIX FIRST" | "DO NOT MERGE" | "UNKNOWN";

export type AuditVerdict = {
  verdict: VerdictLevel;
  body: string;
  htmlUrl: string;
  author: string;
  createdAt: string;
} | null;

export type EvidenceItem = {
  file: string;
  type: "screenshot" | "video" | "log" | "audio" | "other";
  caption: string;
};

export type DemoEvidence =
  | { status: "available"; capturedAt: string | null; items: EvidenceItem[] }
  | { status: "comment-only"; commentBody: string; commentUrl: string }
  | { status: "none" };

/** Full detail view for a single PR. */
export type PRDetail = PRSummary & {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: boolean | null;
  mergeableState: string;
  baseRef: string;
  /**
   * How many commits `baseRef` (main) has that this PR's branch doesn't —
   * i.e. how far behind main the PR is. Best-effort: 0 if we couldn't
   * compute it (closed/merged PRs, or a failed compare call).
   */
  behindBy: number;
  verdict: AuditVerdict;
  demo: DemoEvidence;
  comments: ThreadComment[];
};

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

type RawIssue = {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
  labels: Array<string | { name?: string }>;
  user?: { login?: string; avatar_url?: string } | null;
  state: string;
  closed_at?: string | null;
  state_reason?: string | null;
};

function labelNames(labels: RawIssue["labels"]): string[] {
  return labels
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean);
}

function mapIssue(i: RawIssue): IdeaSummary {
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    htmlUrl: i.html_url,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    commentCount: i.comments,
    labels: labelNames(i.labels),
    author: i.user?.login ?? "unknown",
    authorAvatar: i.user?.avatar_url ?? "",
    state: i.state === "closed" ? "closed" : "open",
    closedAt: i.closed_at ?? null,
    stateReason: i.state_reason ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Ideas data                                                          */
/* ------------------------------------------------------------------ */

/** The labels that make an issue an "idea" as far as this dashboard is concerned. */
const IDEA_LABELS = ["proposal", "approved", "redraft", "declined"] as const;
/** How many recently-closed ideas the Closed tab shows. */
const CLOSED_TAB_SIZE = 10;
/** Per-label page size for the closed listing (recent only — no pagination). */
const CLOSED_PER_LABEL = 30;

/**
 * Every open issue carrying `label`, following pagination to the end.
 *
 * `listForRepo` treats a comma-separated `labels` value as AND, so each label
 * has to be its own query; callers merge the results. Paginating matters: the
 * previous single unfiltered `per_page: 100` listing silently dropped ideas
 * once the repo had more than 100 open issues (pull requests eat slots too),
 * so approved ideas could vanish from the dashboard while the Builder was
 * still acting on them, and the queue count disagreed with the Scout's gate.
 */
async function listIdeasByLabel(
  repoConfig: RepoConfig,
  label: string,
): Promise<IdeaSummary[]> {
  const octokit = getOctokit();
  const rows = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    state: "open",
    labels: label,
    per_page: 100,
  });
  return rows
    .filter((i) => !i.pull_request)
    .map((i) => mapIssue(i as unknown as RawIssue));
}

/** Recently-closed issues carrying `label` (newest activity first). */
async function listClosedIdeasByLabel(
  repoConfig: RepoConfig,
  label: string,
): Promise<IdeaSummary[]> {
  const res = await getOctokit().rest.issues.listForRepo({
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    state: "closed",
    labels: label,
    per_page: CLOSED_PER_LABEL,
    sort: "updated",
    direction: "desc",
  });
  return res.data
    .filter((i) => !i.pull_request)
    .map((i) => mapIssue(i as unknown as RawIssue));
}

/** Merge several label queries into one list, keeping the first copy seen. */
function dedupeByNumber(lists: IdeaSummary[][]): IdeaSummary[] {
  const seen = new Set<number>();
  const out: IdeaSummary[] = [];
  for (const list of lists) {
    for (const idea of list) {
      if (seen.has(idea.number)) continue;
      seen.add(idea.number);
      out.push(idea);
    }
  }
  return out;
}

/** Load all four Ideas tabs. */
export async function loadIdeas(
  repoConfig: RepoConfig,
): Promise<IdeasPayload> {
  // `declined` is queried on the OPEN side too, not just the closed one.
  // Declining is two calls — set the label, then close the issue — and if the
  // close failed the issue was left open carrying only `declined`: not in any
  // of the three live tabs (they key off the other labels) and not in the
  // closed tab (it isn't closed). The idea vanished from the dashboard while
  // still sitting open on GitHub.
  // Start fetching the embedding index NOW, so the artifact read overlaps with
  // the eight GitHub queries below rather than adding to them. By the time the
  // scoring step runs, the cache is warm and it is pure arithmetic.
  primeDuplicateIndex();

  const [openLists, closedLists] = await Promise.all([
    Promise.all(IDEA_LABELS.map((l) => listIdeasByLabel(repoConfig, l))),
    Promise.all(IDEA_LABELS.map((l) => listClosedIdeasByLabel(repoConfig, l))),
  ]);

  const open = dedupeByNumber(openLists);
  const has = (idea: IdeaSummary, label: string) => idea.labels.includes(label);
  const isDeclined = (idea: IdeaSummary) => has(idea, "declined");

  // A declined idea is out of play whatever else it still carries — the owner
  // said no, so it must never reappear in a live queue.
  const live = open.filter((i) => !isDeclined(i));

  const waiting = live.filter((i) => has(i, "proposal")).sort(byNewest);
  const approved = live
    .filter((i) => has(i, "approved") && !has(i, "proposal"))
    .sort(byNewest);
  const redraft = live
    .filter((i) => has(i, "redraft") && !has(i, "proposal"))
    .sort(byNewest);

  // Closed ideas, including the ones the owner declined — a decline is the
  // loop's only "no", so it has to stay visible rather than disappear into an
  // unfiltered listing of whatever closed most recently. Open-but-declined
  // ideas ride along here: the decision was made, only the close didn't land.
  const closed = dedupeByNumber([open.filter(isDeclined), ...closedLists])
    .sort(byClosed)
    .slice(0, CLOSED_TAB_SIZE);

  // Scored over exactly what the four tabs are about to render, so every match
  // the UI links to is an idea the owner can actually see. This never throws
  // and never blocks: it returns null on any failure and the screen is
  // unchanged. No text is embedded here — the vectors already exist. See
  // lib/dedup/queue-duplicates.ts for why this is not the deployed Lambda.
  const [duplicates] = await Promise.all([
    findQueueDuplicates(repoConfig, [...waiting, ...approved, ...redraft, ...closed]),
    attachCoverLinks(repoConfig, [...waiting, ...approved, ...redraft]),
  ]);

  return { waiting, approved, redraft, closed, duplicates };
}

/** Covered ideas whose links are looked up per load — one comment listing each. */
const MAX_COVERED_LOOKUPS = 20;

/**
 * Fill `coveredBy` on every live idea carrying the `covered` flag, from the newest
 * covered comment on its thread. One extra request per FLAGGED idea only, and a
 * failed one leaves an empty list (the chip still shows; the links are one tap away
 * on GitHub) rather than failing the whole Ideas screen.
 */
async function attachCoverLinks(repoConfig: RepoConfig, ideas: IdeaSummary[]): Promise<void> {
  const flagged = ideas.filter((i) => i.labels.includes(COVERED_LABEL)).slice(0, MAX_COVERED_LOOKUPS);
  await Promise.all(
    flagged.map(async (idea) => {
      try {
        const comments = await listThreadComments(idea.number, repoConfig);
        idea.coveredBy = latestCoverLinks(comments, repoConfig) ?? [];
      } catch (err) {
        console.warn(`ideas: couldn't read the covered note on #${idea.number}`, err);
        idea.coveredBy = [];
      }
    }),
  );
}

/**
 * Just the `approved` tab, without paying for the other three.
 *
 * `loadIdeas` does eight paginated GitHub queries and then scores the whole
 * queue for near-duplicates against an embedding index. The staleness check
 * only ever looks at approved ideas, and it runs behind its own interval gate,
 * so making it drag the entire Ideas payload along would be several times the
 * work for one quarter of the answer.
 *
 * Same exclusions the Approved tab applies: a `declined` idea is out of play
 * whatever else it carries, and one still wearing `proposal` has not really
 * been approved yet. A `stale` label is NOT an exclusion — a flagged idea is
 * still approved, still in the Builder's path, and re-assessing it is how the
 * flag would get corroborated or (by the owner) cleared.
 */
export async function listApprovedIdeas(
  repoConfig: RepoConfig,
): Promise<IdeaSummary[]> {
  const rows = await listIdeasByLabel(repoConfig, "approved");
  return rows
    .filter((i) => !i.labels.includes("declined") && !i.labels.includes("proposal"))
    .sort(byNewest);
}

function byNewest(a: IdeaSummary, b: IdeaSummary) {
  return +new Date(b.createdAt) - +new Date(a.createdAt);
}

/**
 * When an idea was closed, as a sortable number. Closed issues always carry
 * `closed_at`; `updatedAt` is only a fallback for a malformed payload, and it
 * is applied through this one accessor so two entries are never compared on
 * different clocks (a genuine close time against someone's last edit).
 */
function closedTime(i: IdeaSummary): number {
  const closed = i.closedAt ? Date.parse(i.closedAt) : NaN;
  if (!Number.isNaN(closed)) return closed;
  const updated = Date.parse(i.updatedAt);
  return Number.isNaN(updated) ? 0 : updated;
}

function byClosed(a: IdeaSummary, b: IdeaSummary) {
  return closedTime(b) - closedTime(a);
}

/** One issue's current title/body/labels/state — for building AI context. */
export async function getIssue(
  issueNumber: number,
  repoConfig: RepoConfig,
): Promise<{ number: number; title: string; body: string; labels: string[]; state: "open" | "closed" }> {
  const res = await getOctokit().rest.issues.get({
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    issue_number: issueNumber,
  });
  return {
    number: res.data.number,
    title: res.data.title,
    body: res.data.body ?? "",
    labels: labelNames(res.data.labels as RawIssue["labels"]),
    state: res.data.state === "closed" ? "closed" : "open",
  };
}

/** List the comment thread for an issue or PR (they share the endpoint). */
export async function listThreadComments(
  issueNumber: number,
  repoConfig: RepoConfig,
): Promise<ThreadComment[]> {
  const res = await getOctokit().rest.issues.listComments({
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return res.data.map((c) => ({
    id: c.id,
    author: c.user?.login ?? "unknown",
    authorAvatar: c.user?.avatar_url ?? "",
    body: c.body ?? "",
    createdAt: c.created_at,
    htmlUrl: c.html_url,
    isBot: (c.user?.type === "Bot") || (c.user?.login ?? "").endsWith("[bot]"),
  }));
}

/**
 * List formal PR reviews (`gh pr review --comment`) as ThreadComment-shaped
 * entries. The Auditor's prompt says "post ONE review comment," which an
 * agent run can reasonably satisfy either with a plain issue comment
 * (`gh pr comment`) or a formal review (`gh pr review --comment`) — both are
 * valid GitHub objects, but they live in different API endpoints. Without
 * this, a verdict posted the second way is invisible to the dashboard even
 * though it's clearly visible on GitHub itself.
 */
async function listPRReviewComments(
  prNumber: number,
  repoConfig: RepoConfig,
): Promise<ThreadComment[]> {
  const res = await getOctokit().rest.pulls.listReviews({
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return res.data
    .filter((r) => (r.body ?? "").trim().length > 0)
    .map((r) => ({
      id: r.id,
      author: r.user?.login ?? "unknown",
      authorAvatar: r.user?.avatar_url ?? "",
      body: r.body ?? "",
      createdAt: r.submitted_at ?? "",
      htmlUrl: r.html_url,
      isBot: r.user?.type === "Bot" || (r.user?.login ?? "").endsWith("[bot]"),
    }));
}

/** Close an issue (used by the Decline action). */
export async function closeIssue(
  issueNumber: number,
  stateReason: "completed" | "not_planned" = "not_planned",
  repoConfig: RepoConfig,
) {
  const res = await getOctokit().rest.issues.update({
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    issue_number: issueNumber,
    state: "closed",
    state_reason: stateReason,
  });
  return res.data;
}

/** Reopen a previously closed issue (used by the Rebuild-fresh action). */
export async function reopenIssue(
  issueNumber: number,
  repoConfig: RepoConfig,
) {
  const res = await getOctokit().rest.issues.update({
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    issue_number: issueNumber,
    state: "open",
  });
  return res.data;
}

/* ------------------------------------------------------------------ */
/* Builds / PR data                                                    */
/* ------------------------------------------------------------------ */

type RawPR = {
  number: number;
  title: string;
  head: { ref: string };
  base?: { ref: string };
  html_url: string;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  state: string;
  draft?: boolean;
  user?: { login?: string; avatar_url?: string } | null;
};

function mapPR(p: RawPR, merged: boolean): PRSummary {
  return {
    number: p.number,
    title: p.title,
    headRef: p.head.ref,
    htmlUrl: p.html_url,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at ?? null,
    closedAt: p.closed_at ?? null,
    state: p.state === "closed" ? "closed" : "open",
    merged,
    author: p.user?.login ?? "unknown",
    authorAvatar: p.user?.avatar_url ?? "",
    draft: Boolean(p.draft),
  };
}

/**
 * Head branches the Builder pushes to. The Builds queue's "needs review" tab
 * is exactly the open PRs on one of these, so routes that must decide whether
 * a PR number really belongs to this project's build queue share the test.
 */
export const isBuilderBranch = (ref: string) => ref.startsWith("claude/");

/** Load the three Builds tabs. */
export async function loadBuilds(
  repoConfig: RepoConfig,
): Promise<BuildsPayload> {
  const { owner, repo } = repoConfig;
  const octokit = getOctokit();

  // Two listings on purpose.
  //
  // The recent-activity page (`state: "all"`, newest-updated first) is all the
  // merged/closed tabs need — they only ever show the last 15.
  //
  // The open PRs are PAGINATED and queried as `state: "open"`, because
  // `capCount` has to agree with the Builder, which counts its slots with
  // `gh pr list --state open --limit 200` minus drafts. Reading one unpaginated
  // page of `state: "all"` meant a busy repo's older open PRs fell off the end:
  // the dashboard showed free slots the Builder didn't believe in and the queue
  // looked open while the Builder was standing down.
  const [recentRes, openPRsRaw] = await Promise.all([
    octokit.rest.pulls.list({
      owner,
      repo,
      state: "all",
      per_page: 100,
      sort: "updated",
      direction: "desc",
    }),
    octokit.paginate(octokit.rest.pulls.list, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    }),
  ]);
  const prs = recentRes.data as unknown as RawPR[];
  const openPRs = openPRsRaw as unknown as RawPR[];

  // Drafts stay VISIBLE here (each row carries `draft`) but are excluded from
  // `capCount` below, because that is exactly how the Builder counts its own
  // slots. Hiding them made a draft PR invisible; counting them made the
  // dashboard show a free slot the Builder didn't believe in.
  const needsReview = openPRs
    .filter((p) => isBuilderBranch(p.head.ref))
    .map((p) => mapPR(p, false))
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const capCount = needsReview.filter((p) => !p.draft).length;

  const merged = prs
    .filter((p) => p.state === "closed" && p.merged_at)
    .map((p) => mapPR(p, true))
    .sort(
      (a, b) => +new Date(b.mergedAt ?? 0) - +new Date(a.mergedAt ?? 0),
    )
    .slice(0, 15);

  const closed = prs
    .filter((p) => p.state === "closed" && !p.merged_at)
    .map((p) => mapPR(p, false))
    .sort(
      (a, b) => +new Date(b.closedAt ?? 0) - +new Date(a.closedAt ?? 0),
    )
    .slice(0, 15);

  return { needsReview, merged, closed, capCount };
}

/** Full PR detail: stats, comments, audit verdict, and demo evidence. */
export async function loadPRDetail(
  prNumber: number,
  repoConfig: RepoConfig,
): Promise<PRDetail> {
  const { owner, repo } = repoConfig;
  const octokit = getOctokit();

  const prRes = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const p = prRes.data;

  const [issueComments, reviewComments] = await Promise.all([
    listThreadComments(prNumber, repoConfig),
    listPRReviewComments(prNumber, repoConfig),
  ]);
  const comments = [...issueComments, ...reviewComments].sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
  );
  const verdict = parseAuditFromComments(comments);
  const demo = await resolveDemoEvidence(prNumber, p.head.sha, comments, repoConfig);
  const behindBy =
    p.state === "open"
      ? await countCommitsBehindMain(p.base?.ref, p.head?.ref, repoConfig)
      : 0;

  return {
    ...mapPR(p as unknown as RawPR, Boolean(p.merged)),
    body: p.body ?? "",
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changed_files ?? 0,
    mergeable: p.mergeable,
    mergeableState: p.mergeable_state ?? "unknown",
    baseRef: p.base?.ref ?? "main",
    behindBy,
    verdict,
    demo,
    comments,
  };
}

/**
 * Best-effort: how many commits `baseRef` (main) has that `headRef` (the PR
 * branch) doesn't yet — i.e. how far behind main the PR is getting. Used to
 * show an early "falling behind" warning before it turns into a hard
 * conflict. Never throws; returns 0 on any error so a flaky compare call
 * can't break the PR card.
 */
async function countCommitsBehindMain(
  baseRef: string | undefined,
  headRef: string | undefined,
  repoConfig: RepoConfig,
): Promise<number> {
  if (!baseRef || !headRef) return 0;
  const { owner, repo } = repoConfig;
  try {
    const res = await getOctokit().rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseRef}...${headRef}`,
    });
    return res.data.behind_by ?? 0;
  } catch {
    return 0;
  }
}

/** Close a PR without merging. */
export async function closePR(
  prNumber: number,
  repoConfig: RepoConfig,
) {
  const res = await getOctokit().rest.pulls.update({
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    pull_number: prNumber,
    state: "closed",
  });
  return res.data;
}

/* ------------------------------------------------------------------ */
/* Audit-verdict parsing                                               */
/* ------------------------------------------------------------------ */

/**
 * The Auditor (posted by `claude[bot]`) leaves a comment whose header reads
 * like "## 🔍 Adversarial audit — PR #NN" and which contains a line such as:
 *   **Verdict:** ✅ **SHIP**
 *   **Verdict: SHIP** ✅ (with a few non-blocking follow-ups)
 *   **Verdict:** FIX FIRST
 *   **Verdict:** DO NOT MERGE
 * We find the newest audit comment and read the verdict keyword.
 */
export function classifyVerdict(body: string): VerdictLevel {
  const m = body.match(/verdict[:*\s]*([^\n]{0,60})/i);
  const window = (m ? m[1] : body).toUpperCase();
  const check = (s: string) => {
    if (/DO\s*NOT\s*MERGE/.test(s)) return "DO NOT MERGE" as const;
    if (/FIX\s*FIRST/.test(s)) return "FIX FIRST" as const;
    if (/\bSHIP\b/.test(s)) return "SHIP" as const;
    return null;
  };
  return check(window) ?? check(body.toUpperCase()) ?? "UNKNOWN";
}

function isAuditComment(c: ThreadComment): boolean {
  return c.isBot && /adversarial audit/i.test(c.body);
}

export function parseAuditFromComments(comments: ThreadComment[]): AuditVerdict {
  const audits = comments
    .filter(isAuditComment)
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  if (audits.length === 0) return null;
  const latest = audits[audits.length - 1];
  return {
    verdict: classifyVerdict(latest.body),
    body: latest.body,
    htmlUrl: latest.htmlUrl,
    author: latest.author,
    createdAt: latest.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* Demo evidence                                                       */
/* ------------------------------------------------------------------ */

/** The "📸 Demo evidence" PR comment, if the Demo agent posted one. */
function findDemoComment(comments: ThreadComment[]): ThreadComment | null {
  const hits = comments.filter(
    (c) => c.isBot && /demo evidence/i.test(c.body),
  );
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * Decide what demo evidence we can show for a PR:
 *  - "available"    : the artifact exists, is unexpired, and has a manifest.
 *  - "comment-only" : no usable artifact but the Demo agent posted a comment
 *                     (e.g. the 30-day artifact retention expired).
 *  - "none"         : nothing yet.
 */
export async function resolveDemoEvidence(
  prNumber: number,
  _headSha: string,
  comments: ThreadComment[],
  repoConfig: RepoConfig,
): Promise<DemoEvidence> {
  const demoComment = findDemoComment(comments);
  try {
    const manifest = await loadEvidenceManifest(prNumber, repoConfig);
    if (manifest && manifest.items.length > 0) {
      return {
        status: "available",
        capturedAt: manifest.captured_at ?? null,
        items: manifest.items,
      };
    }
  } catch {
    // fall through to comment / none
  }
  if (demoComment) {
    return {
      status: "comment-only",
      commentBody: demoComment.body,
      commentUrl: demoComment.htmlUrl,
    };
  }
  return { status: "none" };
}

/* Re-exported from the evidence module so API routes have a single import. */
export { loadEvidenceManifest, readEvidenceFile };
