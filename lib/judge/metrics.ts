/**
 * Agreement statistics for the proposal judge: how often its call matches the
 * owner's, corrected for chance, with intervals wide enough to be honest at n ≈ 50.
 *
 * Raw agreement alone flatters any judge on a lopsided set: if 77% of proposals were
 * never approved, a judge that says "not now" to everything agrees 77% of the time.
 * So every summary carries the majority-class baseline next to it and Cohen's kappa
 * (agreement beyond what the two base rates produce by chance), and every figure
 * carries a 95% interval.
 *
 * Pure functions, seeded randomness, no relative imports (the .mjs scripts import this
 * file by path).
 */

export type Call = "approve" | "not-now";

/** One golden example scored by the judge. */
export type Scored = {
  id: string;
  /** The owner's call (the golden label). */
  label: Call;
  /** The judge's call. */
  verdict: Call;
  /** The judge's probability that the owner approves, when it gave one. */
  p_approve?: number | null;
};

export type Confusion = {
  n: number;
  /** Judge and owner both said approve. */
  both_approve: number;
  /** Judge and owner both said not now. */
  both_not_now: number;
  /** Judge said approve; the owner did not approve. */
  judge_approve_owner_not_now: number;
  /** Judge said not now; the owner approved. The costly miss for a gate. */
  judge_not_now_owner_approve: number;
};

export function confusion(rows: Scored[]): Confusion {
  const c: Confusion = {
    n: rows.length,
    both_approve: 0,
    both_not_now: 0,
    judge_approve_owner_not_now: 0,
    judge_not_now_owner_approve: 0,
  };
  for (const r of rows) {
    if (r.label === "approve" && r.verdict === "approve") c.both_approve++;
    else if (r.label === "not-now" && r.verdict === "not-now") c.both_not_now++;
    else if (r.label === "not-now") c.judge_approve_owner_not_now++;
    else c.judge_not_now_owner_approve++;
  }
  return c;
}

export function agreement(c: Confusion): number | null {
  return c.n === 0 ? null : (c.both_approve + c.both_not_now) / c.n;
}

/**
 * Cohen's kappa: (observed − chance) / (1 − chance), where chance is the agreement two
 * raters with these base rates would reach by luck. Null when chance agreement is 1 -
 * both raters gave a single class - because kappa is undefined there, and reporting
 * 0 or 1 instead would be a made-up number.
 */
export function cohenKappa(c: Confusion): number | null {
  if (c.n === 0) return null;
  const po = (c.both_approve + c.both_not_now) / c.n;
  const ownerApprove = (c.both_approve + c.judge_not_now_owner_approve) / c.n;
  const judgeApprove = (c.both_approve + c.judge_approve_owner_not_now) / c.n;
  const pe = ownerApprove * judgeApprove + (1 - ownerApprove) * (1 - judgeApprove);
  if (pe >= 1 - 1e-12) return null;
  return (po - pe) / (1 - pe);
}

/** Agreement of a judge that always gives the owner's more common answer. */
export function majorityBaseline(rows: Scored[]): { call: Call | null; agreement: number | null } {
  if (!rows.length) return { call: null, agreement: null };
  const approve = rows.filter((r) => r.label === "approve").length;
  const call: Call = approve * 2 >= rows.length ? "approve" : "not-now";
  return { call, agreement: Math.max(approve, rows.length - approve) / rows.length };
}

/**
 * ROC AUC of `p_approve` against the owner's approvals (Mann–Whitney, ties count
 * half). Null when either class is empty or any row has no probability.
 */
export function rocAuc(rows: Scored[]): number | null {
  if (rows.some((r) => typeof r.p_approve !== "number")) return null;
  const pos = rows.filter((r) => r.label === "approve").map((r) => r.p_approve as number);
  const neg = rows.filter((r) => r.label === "not-now").map((r) => r.p_approve as number);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Wilson score interval for k successes in n trials (95% by default). */
export function wilson(k: number, n: number, z = 1.959963984540054): [number, number] | null {
  if (n === 0) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** mulberry32 - small, fast, and the same sequence on every machine for a seed. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 95% percentile bootstrap interval of `stat` over resamples of `rows`. Resamples on
 * which the statistic is undefined (null) are skipped and counted, so an interval
 * built from fewer valid resamples says so rather than hiding it.
 */
export function bootstrapCi<T>(
  rows: T[],
  stat: (sample: T[]) => number | null,
  reps: number,
  seed: number,
): { ci95: [number, number] | null; valid_resamples: number; reps: number } {
  if (!rows.length) return { ci95: null, valid_resamples: 0, reps };
  const rng = seededRng(seed);
  const values: number[] = [];
  for (let i = 0; i < reps; i++) {
    const sample: T[] = new Array(rows.length);
    for (let j = 0; j < rows.length; j++) sample[j] = rows[Math.floor(rng() * rows.length)];
    const v = stat(sample);
    if (v !== null && Number.isFinite(v)) values.push(v);
  }
  if (!values.length) return { ci95: null, valid_resamples: 0, reps };
  values.sort((a, b) => a - b);
  const at = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * (values.length - 1))))];
  return { ci95: [at(0.025), at(0.975)], valid_resamples: values.length, reps };
}

const round = (x: number | null | undefined, d = 3): number | null =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

const roundPair = (p: [number, number] | null): [number, number] | null =>
  p ? [round(p[0]) as number, round(p[1]) as number] : null;

/**
 * Everything the results file reports for one slice of the golden set. When only one
 * class of owner label is present the slice cannot measure two-sided agreement at all;
 * it says so in `one_class`, and kappa is null rather than a number that means nothing.
 */
export function summarize(rows: Scored[], opts: { reps: number; seed: number }) {
  const c = confusion(rows);
  const ownerApprovals = rows.filter((r) => r.label === "approve").length;
  const oneClass = ownerApprovals === 0 || ownerApprovals === rows.length ? (ownerApprovals ? "approve" : "not-now") : null;
  const agreeCount = c.both_approve + c.both_not_now;
  const agreementBoot = bootstrapCi(rows, (s) => agreement(confusion(s)), opts.reps, opts.seed);
  const kappaBoot = oneClass ? null : bootstrapCi(rows, (s) => cohenKappa(confusion(s)), opts.reps, opts.seed);
  const base = majorityBaseline(rows);
  return {
    n: c.n,
    owner_approvals: ownerApprovals,
    owner_not_now: c.n - ownerApprovals,
    one_class: oneClass,
    confusion: c,
    agreement: round(agreement(c)),
    agreement_count: `${agreeCount}/${c.n}`,
    agreement_wilson_95ci: roundPair(wilson(agreeCount, c.n)),
    agreement_bootstrap_95ci: roundPair(agreementBoot.ci95),
    cohen_kappa: oneClass ? null : round(cohenKappa(c)),
    cohen_kappa_bootstrap_95ci: kappaBoot ? roundPair(kappaBoot.ci95) : null,
    kappa_valid_resamples: kappaBoot ? kappaBoot.valid_resamples : null,
    majority_baseline: { call: base.call, agreement: round(base.agreement) },
    judge_approve_rate: round(c.n ? (c.both_approve + c.judge_approve_owner_not_now) / c.n : null),
    /** Of the proposals the owner approved, the share the judge would have held. */
    held_owner_approvals: ownerApprovals
      ? `${c.judge_not_now_owner_approve}/${ownerApprovals}`
      : null,
    roc_auc_p_approve: round(rocAuc(rows)),
  };
}
