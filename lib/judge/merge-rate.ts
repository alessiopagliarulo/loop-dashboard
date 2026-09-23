/**
 * The agent PR merge rate, counted several stated ways, and the post-gate figure that
 * can only be counted once the judge gate has actually run in front of real builds.
 *
 * WHY SEVERAL RULES, ALL REPORTED
 * -------------------------------
 * "The merge rate" has been quoted as 22/48 and 22/49 for the same repo. The difference
 * is the counting rule - which PRs count as the agent's, and whether PRs still open
 * count against it. So every figure here names its rule in plain words, all of them are
 * reported side by side, and none is singled out as the headline.
 *
 * WHY THE POST-GATE FIGURE IS USUALLY EMPTY
 * -----------------------------------------
 * The judge gate's effect on merges can only be observed from PRs the Builder opened
 * AFTER the gate scored the proposal they build. Nothing here models, simulates or
 * extrapolates that number: it is counted from real PRs, and until there are any it is
 * reported as not measured, with n = 0.
 *
 * Pure functions; no relative imports (scripts import this file by path).
 */

export type PrRecord = {
  repo: string;
  number: number;
  author: string;
  head_ref: string;
  state: "open" | "closed";
  merged_at: string | null;
  created_at: string;
  linked_issues: number[];
  /** The PR links a Scout proposal in its repo (recorded by scripts/judge/snapshot.mjs). */
  builds_proposal: boolean;
  /** Set when the judge gate scored the linked proposal before this PR was opened. */
  gate?: { verdict: "approve" | "not-now"; judged_at: string; issue: number } | null;
};

/** Pinned to config/loop-template/files/loop-inflight.mjs → LOOP_AUTHOR_PATTERNS by a test. */
export const LOOP_AUTHOR_PATTERNS = ["claude", "github-actions", "[bot]", "anthropic"];

export function isLoopAuthor(login: string): boolean {
  const t = login.toLowerCase();
  return LOOP_AUTHOR_PATTERNS.some((p) => t.includes(p));
}

/**
 * A loop PR, by the loop's own definition (docs/the-loop.md): a `claude/` branch in
 * the repo, opened by the loop's own identity. The owner's hand-made PRs from a
 * `claude/...` branch are not the loop's.
 */
export function isLoopPr(pr: PrRecord): boolean {
  return pr.head_ref.startsWith("claude/") && isLoopAuthor(pr.author);
}

export type RateCount = {
  merged: number;
  closed_unmerged: number;
  open: number;
  denominator: number;
  rate: number | null;
  count: string;
  wilson_95ci: [number, number] | null;
};

function wilson(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return [r(Math.max(0, centre - half)), r(Math.min(1, centre + half))];
}

/** `all`: merged / every PR. `resolved`: merged / (merged + closed unmerged). */
export function countRate(prs: PrRecord[], denominator: "all" | "resolved"): RateCount {
  const merged = prs.filter((p) => p.merged_at).length;
  const open = prs.filter((p) => p.state === "open").length;
  const closedUnmerged = prs.length - merged - open;
  const n = denominator === "all" ? prs.length : merged + closedUnmerged;
  return {
    merged,
    closed_unmerged: closedUnmerged,
    open,
    denominator: n,
    rate: n ? Math.round((merged / n) * 1000) / 1000 : null,
    count: `${merged}/${n}`,
    wilson_95ci: wilson(merged, n),
  };
}

export type MergeRule = {
  id: string;
  rule: string;
  denominator: "all" | "resolved";
  select: (pr: PrRecord) => boolean;
};

/**
 * The three rules the historic figures come from. None is the "right" one; each
 * answers a different question and all three are reported.
 */
export const BASELINE_RULES: MergeRule[] = [
  {
    id: "loop-prs-all",
    rule: "PRs from a claude/ branch opened by the loop's own identity (claude[bot]); merged divided by all of them, open PRs included.",
    denominator: "all",
    select: (pr) => isLoopPr(pr),
  },
  {
    id: "loop-prs-resolved",
    rule: "The same PRs; merged divided by merged plus closed-unmerged. PRs still open are left out.",
    denominator: "resolved",
    select: (pr) => isLoopPr(pr),
  },
  {
    id: "claude-branch-any-author-all",
    rule: "Every PR from a claude/ branch whoever opened it, so the owner's own PRs on claude/ branches count too; merged divided by all of them, open PRs included.",
    denominator: "all",
    select: (pr) => pr.head_ref.startsWith("claude/"),
  },
];

/**
 * The like-for-like comparison for the post-gate figure, fixed before any post-gate PR
 * exists: loop PRs that build a Scout proposal, merged over resolved. The post-gate
 * figure uses exactly this rule plus "the gate scored the proposal first".
 */
export const PROPOSAL_BUILD_RULE: MergeRule = {
  id: "proposal-builds-resolved",
  rule: "Loop PRs (as above) that build a Scout proposal (the PR links the proposal by a closing keyword, a (#N) title or an issue-N branch); merged divided by merged plus closed-unmerged. This is the rule the post-gate figure is counted with.",
  denominator: "resolved",
  select: (pr) => isLoopPr(pr) && pr.builds_proposal,
};

export function applyRule(rule: MergeRule, prs: PrRecord[]) {
  const selected = prs.filter((p) => rule.select(p));
  return {
    id: rule.id,
    rule: rule.rule,
    denominator_rule: rule.denominator,
    ...countRate(selected, rule.denominator),
    prs: selected.map((p) => p.number).sort((a, b) => a - b),
  };
}

/** Post-gate PRs: proposal builds whose proposal the gate scored before the PR opened. */
export function postGate(prs: PrRecord[]) {
  const gated = prs.filter(
    (p) => PROPOSAL_BUILD_RULE.select(p) && p.gate && p.gate.judged_at < p.created_at,
  );
  const counted = countRate(gated, "resolved");
  return {
    rule: `${PROPOSAL_BUILD_RULE.rule} Only PRs whose proposal carried a judge-gate verdict posted before the PR was opened.`,
    measured: counted.denominator > 0,
    ...counted,
    prs: gated.map((p) => p.number).sort((a, b) => a - b),
  };
}
