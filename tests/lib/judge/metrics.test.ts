/**
 * Agreement statistics for the proposal judge, against hand-computed values.
 */

import { describe, expect, it } from "vitest";

import {
  agreement,
  bootstrapCi,
  cohenKappa,
  confusion,
  majorityBaseline,
  rocAuc,
  seededRng,
  summarize,
  wilson,
  type Call,
  type Scored,
} from "../../../lib/judge/metrics";

function rows(spec: Array<[Call, Call, number?]>): Scored[] {
  return spec.map(([label, verdict, p], i) => ({ id: String(i), label, verdict, p_approve: p ?? null }));
}

/** 20 rows: 8 both-approve, 2 judge-approve/owner-not, 3 judge-not/owner-approve, 7 both-not. */
const TWENTY = rows([
  ...Array.from({ length: 8 }, () => ["approve", "approve"] as [Call, Call]),
  ...Array.from({ length: 2 }, () => ["not-now", "approve"] as [Call, Call]),
  ...Array.from({ length: 3 }, () => ["approve", "not-now"] as [Call, Call]),
  ...Array.from({ length: 7 }, () => ["not-now", "not-now"] as [Call, Call]),
]);

describe("confusion, agreement and kappa", () => {
  it("match hand-computed values", () => {
    const c = confusion(TWENTY);
    expect(c).toEqual({ n: 20, both_approve: 8, both_not_now: 7, judge_approve_owner_not_now: 2, judge_not_now_owner_approve: 3 });
    expect(agreement(c)).toBeCloseTo(0.75, 10);
    // owner approve 11/20, judge approve 10/20 → pe = .55*.5 + .45*.5 = .5 → kappa = (.75-.5)/.5
    expect(cohenKappa(c)).toBeCloseTo(0.5, 10);
  });

  it("kappa is undefined, not 0 or 1, when both raters gave one class", () => {
    expect(cohenKappa(confusion(rows([["approve", "approve"], ["approve", "approve"]])))).toBeNull();
    expect(cohenKappa(confusion([]))).toBeNull();
    // Only the owner is one-class: kappa is defined, and 0 here.
    expect(cohenKappa(confusion(rows([["approve", "approve"], ["approve", "not-now"]])))).toBeCloseTo(0, 10);
  });

  it("a judge that always agrees with the majority gets the baseline and kappa 0", () => {
    const lopsided = rows([["approve", "not-now"], ["not-now", "not-now"], ["not-now", "not-now"], ["not-now", "not-now"]]);
    expect(majorityBaseline(lopsided)).toEqual({ call: "not-now", agreement: 0.75 });
    expect(agreement(confusion(lopsided))).toBe(0.75);
    expect(cohenKappa(confusion(lopsided))).toBeCloseTo(0, 10);
  });
});

describe("rocAuc", () => {
  it("is 1 for a perfect ranking, 0 reversed, 0.5 all tied, null without both classes or probabilities", () => {
    expect(rocAuc(rows([["approve", "approve", 0.9], ["not-now", "not-now", 0.1]]))).toBe(1);
    expect(rocAuc(rows([["approve", "approve", 0.1], ["not-now", "not-now", 0.9]]))).toBe(0);
    expect(rocAuc(rows([["approve", "approve", 0.5], ["not-now", "not-now", 0.5]]))).toBe(0.5);
    expect(rocAuc(rows([["approve", "approve", 0.5]]))).toBeNull();
    expect(rocAuc(rows([["approve", "approve"], ["not-now", "not-now", 0.2]]))).toBeNull();
  });
});

describe("intervals", () => {
  it("wilson matches the textbook value", () => {
    const [lo, hi] = wilson(15, 20)!;
    expect(lo).toBeCloseTo(0.5313, 3);
    expect(hi).toBeCloseTo(0.8881, 3);
    expect(wilson(0, 0)).toBeNull();
  });

  it("the bootstrap is deterministic for a seed and skips undefined resamples", () => {
    const a = bootstrapCi(TWENTY, (s) => agreement(confusion(s)), 500, 7);
    const b = bootstrapCi(TWENTY, (s) => agreement(confusion(s)), 500, 7);
    expect(a).toEqual(b);
    expect(a.ci95![0]).toBeLessThan(0.75);
    expect(a.ci95![1]).toBeGreaterThan(0.75);
    const k = bootstrapCi(rows([["approve", "approve"], ["approve", "approve"]]), (s) => cohenKappa(confusion(s)), 100, 1);
    expect(k).toEqual({ ci95: null, valid_resamples: 0, reps: 100 });
  });

  it("seededRng is the same sequence everywhere", () => {
    const r = seededRng(42);
    const seq = [r(), r(), r()];
    const again = seededRng(42);
    expect([again(), again(), again()]).toEqual(seq);
    for (const x of seq) expect(x >= 0 && x < 1).toBe(true);
  });
});

describe("summarize", () => {
  it("reports the baseline and kappa next to agreement", () => {
    const s = summarize(TWENTY, { reps: 200, seed: 1 });
    expect(s).toMatchObject({ n: 20, owner_approvals: 11, one_class: null, agreement: 0.75, agreement_count: "15/20", cohen_kappa: 0.5, held_owner_approvals: "3/11" });
    expect(s.majority_baseline).toEqual({ call: "approve", agreement: 0.55 });
  });

  it("says when a slice holds one class of owner label, and gives no kappa for it", () => {
    const s = summarize(rows([["approve", "approve"], ["approve", "not-now"], ["approve", "approve"]]), { reps: 100, seed: 1 });
    expect(s.one_class).toBe("approve");
    expect(s.cohen_kappa).toBeNull();
    expect(s.cohen_kappa_bootstrap_95ci).toBeNull();
    expect(s.agreement_count).toBe("2/3");
  });
});
