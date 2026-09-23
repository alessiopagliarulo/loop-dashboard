/**
 * The judge's golden set: which Scout proposals carry a label, what the label is,
 * and - the point of this file - where every label came from.
 *
 * WHAT A LABEL MEANS
 * ------------------
 * The judge predicts one thing: the owner's own call on a proposal, "approve it for
 * building" or "not now". So a golden label is the owner's call, read back from what
 * he actually did on GitHub (the approve label, the merge of a build, the decline
 * label), or typed in by hand later with `scripts/judge/label.mjs`.
 *
 * WHY THE KIND IS KEPT, NOT FOLDED AWAY
 * -------------------------------------
 * The record is lopsided. Approvals are explicit acts. There is no explicit "no" in
 * the archived repo at all - the `declined` label was never used - so every negative
 * there is a proposal the owner simply never approved while he was approving others.
 * That is silence, not a rejection, and it is a much weaker label than an approval.
 * Every label therefore carries its `label_kind` and an `unambiguous` flag, and the
 * evaluation reports agreement on the unambiguous decisions alongside the figure that
 * treats "passed over" as a negative, so a reader can see how much of the headline
 * rests on that assumption.
 *
 * WHY PROVENANCE IS A FIELD ON EVERY ROW
 * --------------------------------------
 * `data/gold-pairs-llm.jsonl` shows how easily an LLM-labelled set gets quoted as a
 * human-labelled one. Here every row says `label_provenance`, and the evaluation
 * refuses to pool rows of different provenance into one number. Today every label is
 * human-made; `llm` exists only so that one can never be mistaken for the other.
 *
 * Pure functions only: scripts/judge/snapshot.mjs does the fetching, and the tests
 * feed these canned events. No relative imports, so the .mjs scripts can import this
 * file by path (Node strips the types).
 */

export type LabelProvenance = "human" | "llm";

/** The judge's two answers, and the two values a golden label can take. */
export type Verdict = "approve" | "not-now";

export const VERDICTS: readonly Verdict[] = ["approve", "not-now"];

/**
 * How the owner's call was read off the GitHub record, strongest first.
 *  - approved            the owner put the `approved` label on it (his last explicit call).
 *  - declined            the owner put the `declined` label on it (his last explicit call).
 *  - merged-build        never labelled, but a build of it was merged by the owner.
 *  - closed-not-planned  closed as "not planned" by the owner - which also covers
 *                        obsolete and duplicate ideas, so it is not a clean "no".
 *  - build-closed        a build of it was closed unmerged and nothing else happened.
 *                        On the archived repo whole batches of builds were closed in
 *                        one clean-out and rebuilt, so this is not a clean "no" either.
 *  - passed-over         none of the above: never approved, built or declined.
 */
export type GithubLabelKind =
  | "approved"
  | "declined"
  | "merged-build"
  | "closed-not-planned"
  | "build-closed"
  | "passed-over";

/** Kinds that are an explicit decision by the owner - the only unambiguous labels. */
export const UNAMBIGUOUS_GITHUB_KINDS: readonly GithubLabelKind[] = [
  "approved",
  "declined",
  "merged-build",
];

export type LabelSource = "github-record" | "hand-label";

/** One owner-or-loop action on a proposal issue, as recorded from its timeline. */
export type RecordedEvent = {
  event: "labeled" | "unlabeled" | "closed" | "reopened";
  actor: string;
  at: string;
  label?: string | null;
  state_reason?: string | null;
};

/** A proposal issue's recorded history. */
export type RecordedIssue = {
  repo: string;
  number: number;
  author: string;
  created_at: string;
  state: "open" | "closed";
  events: RecordedEvent[];
};

/** A pull request, reduced to what the labels and the merge-rate counts need. */
export type RecordedPr = {
  repo: string;
  number: number;
  author: string;
  head_ref: string;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merged_by: string | null;
  linked_issues: number[];
};

export type GoldenLabel = {
  id: string;
  repo: string;
  number: number;
  label: Verdict;
  label_provenance: LabelProvenance;
  label_source: LabelSource;
  label_kind: GithubLabelKind | "hand-label";
  unambiguous: boolean;
  decided_by: string | null;
  decided_at: string | null;
  filed_at: string | null;
  /** Explicit owner calls (approve/decline) on OTHER proposals while this one sat open. */
  owner_calls_while_open?: number;
  evidence: string[];
  note?: string;
};

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** `owner/repo#12` - the key that joins proposals, labels and verdicts. */
export function proposalId(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/**
 * Same four patterns the loop template uses for "written by the loop"
 * (config/loop-template/files/loop-inflight.mjs → LOOP_AUTHOR_PATTERNS).
 */
const LOOP_AUTHOR_PATTERNS = ["claude", "github-actions", "[bot]", "anthropic"];

export function isLoopAuthor(login: string | null | undefined): boolean {
  const t = String(login ?? "").toLowerCase();
  return LOOP_AUTHOR_PATTERNS.some((p) => t.includes(p));
}

/**
 * A Scout proposal: an issue the loop wrote AND the loop labelled `proposal`.
 * Retro summaries, "action needed" issues and the owner's own ideas never get that
 * label from the loop, so they fall out here without a title heuristic.
 */
export function isScoutProposal(issue: RecordedIssue): boolean {
  if (!isLoopAuthor(issue.author)) return false;
  return issue.events.some(
    (e) => e.event === "labeled" && e.label === "proposal" && isLoopAuthor(e.actor),
  );
}

/* ------------------------------------------------------------------ */
/* Linking a PR to the issue it builds                                  */
/* ------------------------------------------------------------------ */

/**
 * Issue numbers a PR says it builds: a closing keyword in the body ("Closes #12"),
 * "(#12)" in the title, or an `issue-12` segment in the branch. The last two are the
 * forms the Builder's claim check reads; the closing keywords are GitHub's own. A bare
 * "refs #12" does not count - it means related, not built from.
 */
export function linkedIssues(pr: { title?: string | null; body?: string | null; head_ref?: string | null }): number[] {
  const found = new Set<number>();
  const body = pr.body ?? "";
  for (const m of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi)) {
    found.add(Number(m[1]));
  }
  for (const m of (pr.title ?? "").matchAll(/\(#(\d+)\)/g)) found.add(Number(m[1]));
  for (const m of (pr.head_ref ?? "").matchAll(/issue-(\d+)(?:-|$)/g)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* Reading the owner's call off the record                              */
/* ------------------------------------------------------------------ */

function byTime<T extends { at: string }>(a: T, b: T): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}

/**
 * The owner's call on one proposal, from its recorded events and every recorded PR
 * in the same repo. `owner` is the repo owner's login; only that account's actions
 * count as the owner's. The record cannot tell a click by the owner from a tool acting
 * under his account, and this does not pretend to.
 */
export function deriveGithubLabel(
  issue: RecordedIssue,
  prs: RecordedPr[],
  owner: string,
  ownerCallsWhileOpen?: number,
): GoldenLabel {
  const ownerEvents = issue.events.filter((e) => e.actor === owner).sort(byTime);
  const base = {
    id: proposalId(issue.repo, issue.number),
    repo: issue.repo,
    number: issue.number,
    label_provenance: "human" as const,
    label_source: "github-record" as const,
    filed_at: issue.created_at,
    ...(ownerCallsWhileOpen === undefined ? {} : { owner_calls_while_open: ownerCallsWhileOpen }),
  };

  // 1. The owner's last explicit call - approve or decline - wins.
  const explicit = ownerEvents.filter(
    (e) => e.event === "labeled" && (e.label === "approved" || e.label === "declined"),
  );
  const last = explicit[explicit.length - 1];
  if (last) {
    const approved = last.label === "approved";
    return {
      ...base,
      label: approved ? "approve" : "not-now",
      label_kind: approved ? "approved" : "declined",
      unambiguous: true,
      decided_by: last.actor,
      decided_at: last.at,
      evidence: explicit.map((e) => `labeled ${e.label} by ${e.actor} at ${e.at}`),
    };
  }

  const builds = prs
    .filter((p) => p.repo === issue.repo && p.linked_issues.includes(issue.number))
    .sort((a, b) => a.number - b.number);

  // 2. Never labelled, but the owner merged a build of it.
  const merged = builds.filter((p) => p.merged_at);
  if (merged.length) {
    const first = merged[0];
    return {
      ...base,
      label: "approve",
      label_kind: "merged-build",
      unambiguous: true,
      decided_by: first.merged_by,
      decided_at: first.merged_at,
      evidence: merged.map((p) => `PR #${p.number} (${p.head_ref}) merged by ${p.merged_by ?? "unknown"} at ${p.merged_at}`),
    };
  }

  // 3. Closed as not planned by the owner and left closed.
  const lifecycle = ownerEvents.filter((e) => e.event === "closed" || e.event === "reopened");
  const lastLifecycle = lifecycle[lifecycle.length - 1];
  if (
    issue.state === "closed" &&
    lastLifecycle?.event === "closed" &&
    lastLifecycle.state_reason === "not_planned"
  ) {
    return {
      ...base,
      label: "not-now",
      label_kind: "closed-not-planned",
      unambiguous: false,
      decided_by: lastLifecycle.actor,
      decided_at: lastLifecycle.at,
      evidence: [`closed as not_planned by ${lastLifecycle.actor} at ${lastLifecycle.at}`],
      note: "Closed as not planned without a decline label: can mean obsolete or duplicate, not only rejected.",
    };
  }

  // 4. Built, the build closed unmerged, nothing else.
  const closedBuilds = builds.filter((p) => p.state === "closed" && !p.merged_at);
  if (closedBuilds.length) {
    const lastBuild = closedBuilds[closedBuilds.length - 1];
    return {
      ...base,
      label: "not-now",
      label_kind: "build-closed",
      unambiguous: false,
      decided_by: null,
      decided_at: lastBuild.closed_at,
      evidence: closedBuilds.map((p) => `PR #${p.number} (${p.head_ref}) closed unmerged at ${p.closed_at}`),
      note: "A build was closed unmerged. Builds were closed in batches and rebuilt, so this is not a clean rejection of the idea.",
    };
  }

  // 5. Silence.
  const redrafts = ownerEvents.filter((e) => e.event === "labeled" && e.label === "redraft");
  return {
    ...base,
    label: "not-now",
    label_kind: "passed-over",
    unambiguous: false,
    decided_by: null,
    decided_at: null,
    evidence: [
      "never approved, built, declined or closed by the owner",
      ...redrafts.map((e) => `sent back for a redraft by ${e.actor} at ${e.at}, never approved after`),
    ],
    note: "Passed over, not rejected: the owner never said no. Treating this as a negative is an assumption.",
  };
}

/**
 * How many explicit calls (approve/decline labels) the owner made on OTHER proposals
 * while this one was open - the evidence that "passed over" happened while he was
 * actively choosing, rather than after he stopped looking at the queue at all.
 */
export function ownerCallsWhileOpen(
  issue: RecordedIssue,
  all: RecordedIssue[],
  owner: string,
  closedAt: string | null,
): number {
  const until = closedAt ?? "9999";
  let n = 0;
  for (const other of all) {
    if (other.number === issue.number || other.repo !== issue.repo) continue;
    for (const e of other.events) {
      if (e.actor !== owner || e.event !== "labeled") continue;
      if (e.label !== "approved" && e.label !== "declined") continue;
      if (e.at > issue.created_at && e.at < until) n++;
    }
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Hand labels                                                          */
/* ------------------------------------------------------------------ */

export type HandLabelRow = {
  id: string;
  label: Verdict;
  labeled_at: string;
  labeler: string;
};

/** A hand label, stamped with its provenance so it can never be pooled wrongly. */
export function handLabel(row: HandLabelRow, filedAt: string | null): GoldenLabel {
  const [repo, num] = row.id.split("#");
  return {
    id: row.id,
    repo,
    number: Number(num),
    label: row.label,
    label_provenance: "human",
    label_source: "hand-label",
    label_kind: "hand-label",
    unambiguous: true,
    decided_by: row.labeler,
    decided_at: row.labeled_at,
    filed_at: filedAt,
    evidence: [`hand-labelled by ${row.labeler} at ${row.labeled_at} with scripts/judge/label.mjs`],
  };
}

/** Throws on a row that is not a usable golden label. Names the offending row. */
export function validateLabel(row: unknown, where: string): GoldenLabel {
  const r = row as Partial<GoldenLabel>;
  if (!r || typeof r.id !== "string" || !r.id.includes("#")) throw new Error(`${where}: missing id`);
  if (!VERDICTS.includes(r.label as Verdict)) {
    throw new Error(`${where} (${r.id}): label must be "approve" or "not-now", got ${JSON.stringify(r.label)}`);
  }
  if (r.label_provenance !== "human" && r.label_provenance !== "llm") {
    throw new Error(`${where} (${r.id}): label_provenance must be "human" or "llm"`);
  }
  if (typeof r.unambiguous !== "boolean") throw new Error(`${where} (${r.id}): unambiguous must be true or false`);
  return r as GoldenLabel;
}
