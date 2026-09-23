/**
 * GitHub plumbing.
 *
 * A single Octokit client (authenticated with GITHUB_TOKEN) plus thin,
 * typed wrappers around the endpoints the dashboard needs. Feature agents
 * are expected to extend this file — keep the wrappers small and predictable.
 *
 * Every helper takes a REQUIRED `repo` argument. There is deliberately no
 * default: a hardcoded fallback repo meant any screen that forgot to pass its
 * project silently read from — and wrote to — the pilot's repo. Callers resolve
 * their repo first (see `resolveProject` in lib/projects.ts) and pass it in.
 */

import { Octokit } from "octokit";

/* ------------------------------------------------------------------ */
/* Repo configuration                                                  */
/* ------------------------------------------------------------------ */

export type RepoConfig = { owner: string; repo: string };

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

let _octokit: Octokit | null = null;

/** Lazily-created, shared Octokit client. */
export function getOctokit(): Octokit {
  if (_octokit) return _octokit;
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set. Add a fine-grained PAT to your environment / Vercel project settings.",
    );
  }
  _octokit = new Octokit({ auth: token });
  return _octokit;
}

/* ------------------------------------------------------------------ */
/* Issues & labels                                                     */
/* ------------------------------------------------------------------ */

/** List issues, optionally filtered by one or more labels. */
export async function listIssues(
  labels: string | string[] | undefined,
  opts: {
    state?: "open" | "closed" | "all";
    per_page?: number;
    repo: RepoConfig;
  },
) {
  const { owner, repo } = opts.repo;
  const res = await getOctokit().rest.issues.listForRepo({
    owner,
    repo,
    state: opts.state ?? "open",
    per_page: opts.per_page ?? 100,
    labels: Array.isArray(labels) ? labels.join(",") : labels,
  });
  // Filter out pull requests, which the issues endpoint also returns.
  return res.data.filter((i) => !i.pull_request);
}

/** Add one or more labels to an issue / PR. */
export async function addLabel(
  issueNumber: number,
  labels: string | string[],
  repo: RepoConfig,
) {
  const res = await getOctokit().rest.issues.addLabels({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issueNumber,
    labels: Array.isArray(labels) ? labels : [labels],
  });
  return res.data;
}

/** Remove a single label from an issue / PR. */
export async function removeLabel(
  issueNumber: number,
  label: string,
  repo: RepoConfig,
) {
  const res = await getOctokit().rest.issues.removeLabel({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issueNumber,
    name: label,
  });
  return res.data;
}

/**
 * Replace an issue's labels with exactly `labels`, in ONE request.
 *
 * Prefer this over add+remove pairs for any queue transition: an add followed
 * by a remove leaves the issue in a dual-label state for as long as the two
 * calls take, and the dashboard and the Builder read that intermediate state
 * differently (the UI still says "waiting" while the Builder starts building).
 * `setLabels` is atomic, so no such window exists.
 *
 * Resilient to a label the repo doesn't have yet, the same way `createIssue`
 * is. `declined` in particular exists on neither live repo, and a failed
 * setLabels aborted the whole Decline action *before* the issue was closed —
 * leaving the idea sitting in the queue as if nothing had happened. On a
 * 404/422 we check which of the requested labels are genuinely missing, create
 * exactly those, and retry once. If none were missing, the error was about
 * something else and is rethrown untouched.
 */
export async function setIssueLabels(
  issueNumber: number,
  labels: string[],
  repo: RepoConfig,
) {
  const octokit = getOctokit();
  const set = () =>
    octokit.rest.issues.setLabels({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
      labels,
    });

  try {
    return (await set()).data;
  } catch (err: unknown) {
    if (labels.length === 0 || !mayBeMissingLabelError(err)) throw err;
    const createdAny = await createMissingLabels(labels, repo);
    if (!createdAny) throw err; // nothing was missing — not a label problem
    return (await set()).data;
  }
}

/**
 * The loop's triage vocabulary: the labels the dashboard, the Scout and the
 * Builder all agree on. Defined ONCE here so onboarding (which creates them on
 * a new repo) and the on-the-fly creation below can never drift apart — they
 * did: two colors for `declined` shipped at the same time.
 */
export const LOOP_LABELS: Record<string, { color: string; description: string }> = {
  proposal: {
    color: "0E8A16",
    description: "Agent-proposed improvement awaiting your triage",
  },
  approved: {
    color: "1D76DB",
    description: "Owner-approved: builder loop may implement",
  },
  redraft: {
    color: "D93F0B",
    description: "Owner sent this proposal back for the agent to rewrite from feedback",
  },
  // The rejection channel: an explicit "no" the Scout can learn from. Grey on
  // purpose — it reads as closed/inactive next to the green/blue/orange three.
  declined: {
    color: "6E7781",
    description: "Owner said no — don't build it, and don't propose it again",
  },
  // NOT a queue state — a warning worn ON TOP of `approved`. Amber to match the
  // "falling behind" treatment the PR card already uses for the same idea
  // (something that was fine when it was filed and may not be any more), and
  // deliberately not one of the four triage labels: the owner still decides.
  stale: {
    color: "FBCA04",
    description:
      "Approved before code landed that may have overtaken it — the owner decides",
  },
  // Also a warning, not a state: existing work (the owner's own PR or branch, a
  // recent merge, another idea) already seems to do this. Set by the loop's
  // workflows through config/loop-template/files/loop-inflight.mjs, which pins the
  // same colour and description (tests/lib/loop-inflight.test.ts checks).
  covered: {
    color: "5319E7",
    description:
      "Existing work (a PR, branch, commit or idea) already seems to cover this — the owner decides",
  },
  // A third warning, not a state: the opt-in proposal judge predicts the owner would not
  // approve this as written, so the Builder will not self-pick it. Set by
  // config/loop-template/files/loop-judge.mjs, which pins the same colour and
  // description (tests/lib/loop-judge.test.ts checks). Any owner decision clears it.
  "judge-hold": {
    color: "E99695",
    description:
      "The proposal judge predicts the owner would not approve this as written - advisory, the owner decides",
  },
};

/** Default colors for labels this app may need to create on the fly. */
const LABEL_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(LOOP_LABELS).map(([name, { color }]) => [name, color]),
);

/** Colour used for a label we're asked to create but don't have an opinion on. */
const FALLBACK_LABEL_COLOR = "ededed";

/** Shape of the validation errors GitHub returns inside a 422 body. */
type ValidationError = {
  resource?: string;
  field?: string;
  code?: string;
  message?: string;
  value?: unknown;
};

/**
 * True only when a 422 actually says the *labels* were the problem.
 *
 * Every kind of validation failure is a 422 — a body over the size limit, a
 * blocked user, a repo with issues disabled. Creating labels on the back of
 * any of those left junk labels on the repo and then failed anyway, so we
 * inspect the error payload instead of guessing.
 */
function isMissingLabelError(err: unknown): boolean {
  const e = err as { status?: number; response?: { data?: unknown } };
  if (e?.status !== 422) return false;
  const data = (e.response?.data ?? {}) as {
    message?: string;
    errors?: ValidationError[];
  };
  const errors = Array.isArray(data.errors) ? data.errors : [];
  if (errors.some((x) => x?.field === "labels")) return true;
  // Older/looser payloads only carry prose — fall back to reading it.
  const prose = [data.message ?? "", ...errors.map((x) => x?.message ?? "")]
    .join(" ")
    .toLowerCase();
  return prose.includes("label");
}

/**
 * Could this failure be "one of those labels doesn't exist on the repo"?
 *
 * Broader than {@link isMissingLabelError} because the labels endpoints answer
 * a missing label with either a 422 (validation) or a plain 404 (the label
 * resource isn't there), and a 404 body carries no prose to key off. It is only
 * a *maybe*: the caller confirms by checking which labels actually exist before
 * creating anything, so a 404 that really meant "no such issue" creates nothing
 * and the original error is rethrown.
 */
function mayBeMissingLabelError(err: unknown): boolean {
  return isNotFound(err) || isMissingLabelError(err);
}

/**
 * Create whichever of `labels` the repo doesn't have. Returns true if at least
 * one was genuinely missing (i.e. a retry is worth attempting). Labels we can't
 * confirm either way are left alone — guessing is how junk labels got created.
 */
async function createMissingLabels(
  labels: string[],
  repo: RepoConfig,
): Promise<boolean> {
  const octokit = getOctokit();
  let missing = 0;
  for (const name of labels) {
    try {
      await octokit.rest.issues.getLabel({
        owner: repo.owner,
        repo: repo.repo,
        name,
      });
      continue; // already there
    } catch (err: unknown) {
      if (!isNotFound(err)) continue; // couldn't tell — don't touch it
    }
    missing++;
    try {
      await octokit.rest.issues.createLabel({
        owner: repo.owner,
        repo: repo.repo,
        name,
        color: LABEL_COLORS[name] ?? FALLBACK_LABEL_COLOR,
        description: LOOP_LABELS[name]?.description,
      });
    } catch {
      /* raced with someone else creating it — the retry will tell us */
    }
  }
  return missing > 0;
}

/**
 * Create a new issue. Returns the created issue.
 *
 * Resilient to a missing label: if the create fails *because* one of the
 * requested labels doesn't exist on the repo, the label is created (with a
 * sensible color) and the create is retried once. Any other 422 is rethrown
 * untouched.
 *
 * `opts.assignees` are applied best-effort after the issue exists, so the
 * owner gets a GitHub notification for ideas filed from the dashboard the
 * same way the Scout's `--assignee` flag notifies them. A failure to assign
 * (org-owned repo, non-member login) never loses the filed idea.
 */
export async function createIssue(
  title: string,
  body: string,
  labels: string[],
  repo: RepoConfig,
  opts: { assignees?: string[] } = {},
) {
  const octokit = getOctokit();
  const create = () =>
    octokit.rest.issues.create({
      owner: repo.owner,
      repo: repo.repo,
      title,
      body,
      labels,
    });

  let issue;
  try {
    issue = (await create()).data;
  } catch (err: unknown) {
    if (labels.length === 0 || !isMissingLabelError(err)) throw err;
    for (const name of labels) {
      try {
        await octokit.rest.issues.createLabel({
          owner: repo.owner,
          repo: repo.repo,
          name,
          color: LABEL_COLORS[name] ?? FALLBACK_LABEL_COLOR,
          description: LOOP_LABELS[name]?.description,
        });
      } catch {
        /* already exists or not the problem — ignore and let the retry decide */
      }
    }
    issue = (await create()).data;
  }

  const assignees = (opts.assignees ?? []).filter(Boolean);
  if (assignees.length > 0) {
    try {
      await octokit.rest.issues.addAssignees({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: issue.number,
        assignees,
      });
    } catch (err) {
      console.warn(
        `github: couldn't assign issue #${issue.number} to ${assignees.join(", ")}`,
        err,
      );
    }
  }
  return issue;
}

/**
 * An issue's own event log — the trail GitHub keeps of everything that
 * happened to it that is not a comment.
 *
 * Exists because the issue object itself carries no history: `IdeaSummary` can
 * say an idea IS `approved`, never WHEN it became approved, and "when" is the
 * whole question a staleness check asks. The `labeled` events are the only
 * record of that moment, and they carry `created_at`.
 *
 * Paginated: an issue that has been round-tripped through triage a few times
 * accumulates dozens of events, and the label add we want is usually the
 * OLDEST-but-one rather than anything near the first page's end.
 */
export type IssueLabelEvent = {
  event: string;
  createdAt: string;
  label: string | null;
  actor: string | null;
};

export async function listIssueEvents(
  issueNumber: number,
  repo: RepoConfig,
  opts: { per_page?: number } = {},
): Promise<IssueLabelEvent[]> {
  const octokit = getOctokit();
  const rows = await octokit.paginate(octokit.rest.issues.listEvents, {
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issueNumber,
    per_page: opts.per_page ?? 100,
  });
  return rows.map((e) => {
    const raw = e as unknown as {
      event?: string;
      created_at?: string;
      label?: { name?: string } | null;
      actor?: { login?: string } | null;
    };
    return {
      event: raw.event ?? "",
      createdAt: raw.created_at ?? "",
      label: raw.label?.name ?? null,
      actor: raw.actor?.login ?? null,
    };
  });
}

/** Create a comment on an issue or PR. */
export async function createComment(
  issueNumber: number,
  body: string,
  repo: RepoConfig,
) {
  const res = await getOctokit().rest.issues.createComment({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issueNumber,
    body,
  });
  return res.data;
}

/* ------------------------------------------------------------------ */
/* Pull requests                                                       */
/* ------------------------------------------------------------------ */

/** List pull requests. */
export async function listPRs(
  opts: {
    state?: "open" | "closed" | "all";
    per_page?: number;
    repo: RepoConfig;
  },
) {
  const { owner, repo } = opts.repo;
  const res = await getOctokit().rest.pulls.list({
    owner,
    repo,
    state: opts.state ?? "open",
    per_page: opts.per_page ?? 100,
  });
  return res.data;
}

/** Merge a pull request. */
export async function mergePR(
  prNumber: number,
  opts: {
    merge_method?: "merge" | "squash" | "rebase";
    commit_title?: string;
    repo: RepoConfig;
  },
) {
  const { owner, repo } = opts.repo;
  const res = await getOctokit().rest.pulls.merge({
    owner,
    repo,
    pull_number: prNumber,
    merge_method: opts.merge_method ?? "squash",
    commit_title: opts.commit_title,
  });
  return res.data;
}

/* ------------------------------------------------------------------ */
/* Workflows / Actions                                                 */
/* ------------------------------------------------------------------ */

/**
 * GitHub's run filter, which confusingly accepts a run *status* OR a run
 * *conclusion* in the same parameter (`success` is a conclusion, `in_progress`
 * is a status). Mirrors the endpoint's own union so callers get completion.
 */
export type WorkflowRunStatusFilter =
  | "completed"
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "success"
  | "timed_out"
  | "in_progress"
  | "queued"
  | "requested"
  | "waiting"
  | "pending";

/**
 * List recent workflow runs (optionally scoped to a single workflow file).
 *
 * `status` narrows server-side. It exists because "has this repo EVER had a
 * successful run" cannot be answered honestly from a page of recent runs — the
 * green one may simply be older than the window — and asking GitHub for
 * successes directly is one call instead of paging back through history.
 */
export async function getWorkflowRuns(
  opts: {
    workflowId?: string | number;
    per_page?: number;
    branch?: string;
    status?: WorkflowRunStatusFilter;
    repo: RepoConfig;
  },
) {
  const { owner, repo } = opts.repo;
  const octokit = getOctokit();
  if (opts.workflowId !== undefined) {
    const res = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: opts.workflowId,
      per_page: opts.per_page ?? 30,
      branch: opts.branch,
      status: opts.status,
    });
    return res.data.workflow_runs;
  }
  const res = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    per_page: opts.per_page ?? 30,
    branch: opts.branch,
    status: opts.status,
  });
  return res.data.workflow_runs;
}

/**
 * Trigger a `workflow_dispatch` event for a workflow file (e.g. "scout.yml").
 * `ref` is the git ref to run on (normally "main").
 */
export async function dispatchWorkflow(
  workflowId: string | number,
  ref: string,
  inputs: Record<string, string>,
  repo: RepoConfig,
) {
  await getOctokit().rest.actions.createWorkflowDispatch({
    owner: repo.owner,
    repo: repo.repo,
    workflow_id: workflowId,
    ref,
    inputs,
  });
  return { ok: true };
}

/**
 * Fire a `repository_dispatch` event (used for @claude-style remote control
 * and any custom event the loop listens for).
 */
export async function repositoryDispatch(
  eventType: string,
  payload: Record<string, unknown>,
  repo: RepoConfig,
) {
  await getOctokit().rest.repos.createDispatchEvent({
    owner: repo.owner,
    repo: repo.repo,
    event_type: eventType,
    client_payload: payload,
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

/** List the artifacts produced by a workflow run. */
export async function listRunArtifacts(
  runId: number,
  repo: RepoConfig,
) {
  const res = await getOctokit().rest.actions.listWorkflowRunArtifacts({
    owner: repo.owner,
    repo: repo.repo,
    run_id: runId,
  });
  return res.data.artifacts;
}

/** Download an artifact as a zip. Returns the raw zip bytes as a Buffer. */
export async function downloadArtifact(
  artifactId: number,
  repo: RepoConfig,
): Promise<Buffer> {
  const res = await getOctokit().rest.actions.downloadArtifact({
    owner: repo.owner,
    repo: repo.repo,
    artifact_id: artifactId,
    archive_format: "zip",
  });
  return Buffer.from(res.data as ArrayBuffer);
}

/* ------------------------------------------------------------------ */
/* Commits & branches                                                  */
/* ------------------------------------------------------------------ */

/** A commit on the default branch, flattened to the fields we reason about. */
export type RepoCommit = {
  sha: string;
  /** First 7 characters — what a human reads in a log line. */
  shortSha: string;
  /** Author date (when the work was written), NOT the committer date. */
  committedAt: string;
  authorName: string;
  authorEmail: string;
  /** GitHub login when the commit is linked to an account, else null. */
  authorLogin: string | null;
  /** First line of the commit message. */
  subject: string;
};

/**
 * The repo's default branch name. Not hardcoded to "main": the loop's own
 * template assumes main, but nothing stops a target repo from using `master`
 * or `trunk`, and a staleness check that silently read the wrong branch would
 * report "no commits since approval" forever — the exact silent-no-op failure
 * the change-detection audit is about.
 */
export async function getDefaultBranch(repo: RepoConfig): Promise<string> {
  const res = await getOctokit().rest.repos.get({
    owner: repo.owner,
    repo: repo.repo,
  });
  return res.data.default_branch ?? "main";
}

/**
 * The current tip of the default branch: its name, sha and author date.
 *
 * This is the "what does the repo actually look like right now" anchor the
 * dashboard has never had — every existing read is either an issue, a PR, or a
 * hardcoded file path. Returns `null` rather than throwing on an empty repo,
 * which has a default branch name but no commits on it.
 */
export async function getDefaultBranchHead(
  repo: RepoConfig,
): Promise<{ branch: string; sha: string; committedAt: string } | null> {
  const branch = await getDefaultBranch(repo);
  try {
    const res = await getOctokit().rest.repos.listCommits({
      owner: repo.owner,
      repo: repo.repo,
      sha: branch,
      per_page: 1,
    });
    const head = res.data[0];
    if (!head) return null;
    return {
      branch,
      sha: head.sha,
      committedAt: head.commit?.author?.date ?? head.commit?.committer?.date ?? "",
    };
  } catch (err: unknown) {
    // 409 is GitHub's answer for "this repository is empty".
    if (isNotFound(err) || (err as { status?: number })?.status === 409) return null;
    throw err;
  }
}

/**
 * Commits on the default branch authored strictly after `since` (an ISO
 * timestamp), newest first.
 *
 * `max` is a hard ceiling, not a page size. A repo that has had four hundred
 * commits land since an idea was approved does not need all four hundred read
 * to establish that the idea is stale — the first `max` say it just as loudly,
 * and an unbounded paginate here would turn one queue check into hundreds of
 * API calls against a rate limit shared with every other screen.
 *
 * Note which clock is which: GitHub filters `since` on the COMMITTER date,
 * while `committedAt` below is the AUTHOR date (when the work was written,
 * which is what a person means by "when did this land"). They are the same
 * value except after a rebase or a cherry-pick, where the author date is the
 * older of the two — so a rebased commit can come back from this call and then
 * be filtered out again by a caller comparing `committedAt`. That errs towards
 * counting fewer commits, which for a staleness check errs towards not
 * flagging, which is the right direction.
 */
export async function listCommitsSince(
  since: string,
  repo: RepoConfig,
  opts: { branch?: string; max?: number } = {},
): Promise<RepoCommit[]> {
  const max = opts.max ?? 100;
  const octokit = getOctokit();
  try {
    const res = await octokit.rest.repos.listCommits({
      owner: repo.owner,
      repo: repo.repo,
      sha: opts.branch,
      since,
      per_page: Math.min(100, max),
    });
    return res.data.slice(0, max).map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      committedAt: c.commit?.author?.date ?? c.commit?.committer?.date ?? "",
      authorName: c.commit?.author?.name ?? "",
      authorEmail: c.commit?.author?.email ?? "",
      authorLogin: c.author?.login ?? null,
      subject: (c.commit?.message ?? "").split("\n")[0],
    }));
  } catch (err: unknown) {
    if (isNotFound(err) || (err as { status?: number })?.status === 409) return [];
    throw err;
  }
}

/**
 * The paths one commit touched. Best-effort: an empty list on any failure, so
 * a single unreadable commit degrades the evidence rather than failing the
 * whole check.
 *
 * GitHub truncates `files` at 300 entries per commit. A commit that big is
 * already overwhelming evidence of change, so the truncation costs nothing
 * here — but it is why this must never be read as an exhaustive list.
 */
export async function getCommitFiles(
  sha: string,
  repo: RepoConfig,
): Promise<string[]> {
  try {
    const res = await getOctokit().rest.repos.getCommit({
      owner: repo.owner,
      repo: repo.repo,
      ref: sha,
    });
    return (res.data.files ?? []).map((f) => f.filename).filter(Boolean);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Repository contents                                                 */
/* ------------------------------------------------------------------ */

/**
 * Read a text file from the repo. Returns the decoded string, or `null` if
 * the file does not exist.
 */
export async function getFileContent(
  path: string,
  ref: string | undefined,
  repo: RepoConfig,
): Promise<string | null> {
  try {
    const res = await getOctokit().rest.repos.getContent({
      owner: repo.owner,
      repo: repo.repo,
      path,
      ref,
    });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return null;
    }
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Read a text file AND the blob sha GitHub currently has for it. Returns
 * `null` if the file does not exist.
 *
 * The sha is what makes a read-modify-write safe: hand it back to
 * {@link commitFile} as `expectedSha` and GitHub rejects the write if anything
 * landed on the file in between, instead of silently clobbering it.
 */
export async function getFileWithSha(
  path: string,
  ref: string | undefined,
  repo: RepoConfig,
): Promise<{ content: string; sha: string } | null> {
  try {
    const res = await getOctokit().rest.repos.getContent({
      owner: repo.owner,
      repo: repo.repo,
      path,
      ref,
    });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return null;
    }
    return {
      content: Buffer.from(data.content, "base64").toString("utf-8"),
      sha: data.sha,
    };
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * List the workflow filenames actually present in `.github/workflows/` on a
 * repo (`ref` defaults to the default branch). This is how the dashboard tells
 * whether a given capability (e.g. the demo-evidence or tool-install workflow)
 * is installed on a project — it queries reality rather than assuming. Returns
 * an empty array if the folder is missing or unreadable.
 */
export async function listWorkflowFiles(
  opts: { ref?: string; repo: RepoConfig },
): Promise<string[]> {
  const repo = opts.repo;
  try {
    const res = await getOctokit().rest.repos.getContent({
      owner: repo.owner,
      repo: repo.repo,
      path: ".github/workflows",
      ref: opts.ref,
    });
    if (!Array.isArray(res.data)) return [];
    return res.data
      .filter((e) => e.type === "file" && /\.ya?ml$/.test(e.name))
      .map((e) => e.name);
  } catch (err: unknown) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/**
 * Create or update a text file directly on a branch (defaults to "main") via
 * the contents API.
 *
 * `expectedSha` is the optimistic-concurrency hook, and callers that did a
 * read-modify-write should always pass it:
 *   - a string  → write only if the blob still has that sha. We do NOT look the
 *                 sha up ourselves, so there is no window between the caller's
 *                 read and this write for someone else's save to slip into.
 *                 GitHub answers a stale sha with a 409, which the caller maps
 *                 onto its own "someone else changed this" error.
 *   - `null`    → the caller read the file as ABSENT and means to create it.
 *                 GitHub 422s if it exists after all.
 *   - omitted   → legacy behaviour: look the sha up here (last-write-wins).
 *                 Fine for append-only/registry writes, not for edits a person
 *                 based on something they were shown.
 */
export async function commitFile(
  path: string,
  content: string,
  message: string,
  opts: { branch?: string; repo: RepoConfig; expectedSha?: string | null },
) {
  const repo = opts.repo;
  const branch = opts.branch ?? "main";
  const octokit = getOctokit();

  let sha: string | undefined;
  if (opts.expectedSha !== undefined) {
    sha = opts.expectedSha ?? undefined;
  } else {
    try {
      const existing = await octokit.rest.repos.getContent({
        owner: repo.owner,
        repo: repo.repo,
        path,
        ref: branch,
      });
      if (!Array.isArray(existing.data) && "sha" in existing.data) {
        sha = existing.data.sha;
      }
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
    }
  }

  const res = await octokit.rest.repos.createOrUpdateFileContents({
    owner: repo.owner,
    repo: repo.repo,
    path,
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
    sha,
  });
  return res.data;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: number }).status === 404
  );
}
