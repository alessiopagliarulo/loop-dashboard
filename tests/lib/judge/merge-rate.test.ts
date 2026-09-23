/**
 * The merge-rate counting rules, and the figures the committed record gives under them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BASELINE_RULES, PROPOSAL_BUILD_RULE, applyRule, countRate, isLoopPr, postGate, type PrRecord } from "../../../lib/judge/merge-rate";

const ROOT = join(__dirname, "..", "..", "..");

function pr(number: number, over: Partial<PrRecord> = {}): PrRecord {
  return {
    repo: "acme/shop",
    number,
    author: "claude[bot]",
    head_ref: `claude/x-${number}`,
    state: "closed",
    merged_at: null,
    created_at: "2026-07-10T00:00:00Z",
    linked_issues: [],
    builds_proposal: false,
    gate: null,
    ...over,
  };
}

describe("isLoopPr", () => {
  it("needs a claude/ branch AND the loop's identity", () => {
    expect(isLoopPr(pr(1))).toBe(true);
    expect(isLoopPr(pr(2, { author: "acme" }))).toBe(false);
    expect(isLoopPr(pr(3, { head_ref: "feature/x" }))).toBe(false);
  });
});

describe("countRate", () => {
  const prs = [pr(1, { merged_at: "2026-07-11T00:00:00Z" }), pr(2), pr(3, { state: "open" })];

  it("'all' counts open PRs against the rate, 'resolved' leaves them out", () => {
    expect(countRate(prs, "all")).toMatchObject({ merged: 1, closed_unmerged: 1, open: 1, denominator: 3, count: "1/3", rate: 0.333 });
    expect(countRate(prs, "resolved")).toMatchObject({ denominator: 2, count: "1/2", rate: 0.5 });
    expect(countRate([], "resolved")).toMatchObject({ rate: null, wilson_95ci: null });
  });
});

describe("postGate", () => {
  it("counts only proposal builds opened after the gate scored their proposal", () => {
    const gated = { verdict: "approve" as const, judged_at: "2026-07-09T00:00:00Z", issue: 5 };
    const prs = [
      pr(1, { builds_proposal: true, gate: gated, merged_at: "2026-07-11T00:00:00Z" }),
      pr(2, { builds_proposal: true, gate: { ...gated, judged_at: "2026-07-12T00:00:00Z" } }),
      pr(3, { builds_proposal: false, gate: gated }),
      pr(4, { builds_proposal: true, gate: null }),
      pr(5, { builds_proposal: true, gate: gated, author: "acme" }),
    ];
    expect(postGate(prs)).toMatchObject({ measured: true, count: "1/1", prs: [1] });
    expect(postGate([pr(9, { builds_proposal: true })])).toMatchObject({ measured: false, denominator: 0, rate: null });
  });
});

describe("the committed record", () => {
  const prs = readFileSync(join(ROOT, "data/judge/pull-requests.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => JSON.parse(l) as PrRecord);
  const baseline = prs.filter((p) => p.repo === "alessiopagliarulo/content-generation-platform");
  const count = (id: string) => applyRule([...BASELINE_RULES, PROPOSAL_BUILD_RULE].find((r) => r.id === id)!, baseline).count;

  it("gives the baseline figures the results doc quotes", () => {
    expect(count("loop-prs-all")).toBe("20/47");
    expect(count("loop-prs-resolved")).toBe("20/34");
    expect(count("claude-branch-any-author-all")).toBe("22/49");
    expect(count("proposal-builds-resolved")).toBe("19/29");
  });

  it("reproduces neither historic figure (22 of 48, 22 of 35) under any rule", () => {
    const all = [...BASELINE_RULES, PROPOSAL_BUILD_RULE].map((r) => applyRule(r, baseline).count);
    expect(all).not.toContain("22/48");
    expect(all).not.toContain("22/35");
  });

  it("has no post-gate PR yet, so the post-gate rate is not measured", () => {
    expect(postGate(prs)).toMatchObject({ measured: false, denominator: 0 });
  });

  it("matches metrics/merge-rate.json", () => {
    const m = JSON.parse(readFileSync(join(ROOT, "metrics/merge-rate.json"), "utf8"));
    expect(m.baseline.rules.map((r: { count: string }) => r.count)).toEqual(["20/47", "20/34", "22/49"]);
    expect(m.post_gate).toMatchObject({ measured: false, status: "not yet measured" });
  });
});
