#!/usr/bin/env node
/**
 * Scores the recorded judge answers against the owner's calls → metrics/judge-eval.json.
 *
 *   node scripts/judge/evaluate.mjs [--verdicts data/judge/verdicts/<file>.jsonl]
 *
 * Offline and free: it reads only committed files. Re-running it on unchanged inputs
 * rewrites the same numbers.
 *
 * WHAT IT REFUSES TO DO
 *   - Accept a label that is not human-made. validateLabel stops the run, naming the
 *     file and row. Each label set (the GitHub record, the owner's hand labels) is scored
 *     on its own, and every block names its provenance.
 *   - Fold "passed over" into a clean "no". The GitHub record has explicit approvals and
 *     no explicit rejections, so the figure that treats passed-over proposals as "not
 *     now" is reported next to the figure on the owner's explicit calls alone, with the
 *     share of the agreement that rests on the passed-over ones.
 *   - Report a slice it made up after seeing the answers. The slices below are fixed in
 *     this file, and were committed before the first live judge run.
 *
 * THE SLICES (of the GitHub record)
 *   all_recorded_calls       every proposal; passed-over counted as "not now".
 *   explicit_calls_only      only the owner's explicit acts (approve label, merged build,
 *                            decline label). On this repo that is approvals only, so it
 *                            measures how often the judge agrees with an approval - it
 *                            cannot measure two-sided agreement, and says so.
 *   passed_over_only         only the passed-over proposals.
 *   same_period              proposals filed on or after the first passed-over one, so the
 *                            approvals it is compared with come from the same weeks.
 */

import { readdirSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { UNAMBIGUOUS_GITHUB_KINDS, validateLabel } from "../../lib/judge/golden.ts";
import { summarize } from "../../lib/judge/metrics.ts";
import { BAR_KEYS, JUDGE_PROMPT_VERSION, judgePromptSha } from "../../config/loop-template/files/loop-judge.mjs";
import {
  GITHUB_LABELS_PATH,
  HAND_LABELS_PATH,
  JUDGE_METRICS_PATH,
  PROPOSALS_PATH,
  ROOT,
  VERDICTS_DIR,
  arg,
  readJsonl,
  rel,
  verdictsPath,
} from "./_shared.mjs";

const REPS = 2000;
const SEED = 20260923;

function loadLabels(file) {
  return readJsonl(file, { optional: true }).map((row, i) => validateLabel(row, `${rel(file)} row ${i + 1}`));
}

/** Joins labels to answers by id; labels without an answer are counted, never guessed. */
function score(labels, verdictById) {
  const scored = [];
  const unjudged = [];
  for (const l of labels) {
    const v = verdictById.get(l.id);
    if (!v) {
      unjudged.push(l.id);
      continue;
    }
    scored.push({ id: l.id, label: l.label, verdict: v.verdict, p_approve: v.approve_probability, kind: l.label_kind, unambiguous: l.unambiguous, filed_at: l.filed_at });
  }
  return { scored, unjudged };
}

function slice(rows, definition) {
  return { definition, ...summarize(rows, { reps: REPS, seed: SEED }) };
}

function byKind(rows) {
  const out = {};
  for (const r of rows) {
    const k = (out[r.kind] ??= { n: 0, owner_call: r.label, judge_agreed: 0 });
    k.n++;
    if (r.verdict === r.label) k.judge_agreed++;
  }
  for (const k of Object.values(out)) k.judge_agreement = Math.round((k.judge_agreed / k.n) * 1000) / 1000;
  return out;
}

/** How often each item of the Scout's bar was judged met, split by the owner's call. */
function barRates(rows, verdictById) {
  const out = {};
  for (const call of ["approve", "not-now"]) {
    const group = rows.filter((r) => r.label === call);
    out[`owner_${call.replace("-", "_")}`] = {
      n: group.length,
      ...Object.fromEntries(
        BAR_KEYS.map((k) => [k, group.length ? Math.round((group.filter((r) => verdictById.get(r.id).bar[k]).length / group.length) * 1000) / 1000 : null]),
      ),
    };
  }
  return out;
}

function githubRecordBlock(labels, verdictById) {
  const { scored, unjudged } = score(labels, verdictById);
  const explicit = scored.filter((r) => UNAMBIGUOUS_GITHUB_KINDS.includes(r.kind));
  const passedOver = scored.filter((r) => r.kind === "passed-over");
  const firstPassedOver = passedOver.map((r) => r.filed_at).sort()[0] ?? null;
  const samePeriod = firstPassedOver ? scored.filter((r) => r.filed_at >= firstPassedOver) : [];
  const all = slice(scored, "Every labelled proposal. Proposals the owner passed over (never approved, built or declined) are counted as his 'not now'. That is an assumption: he never said no to any of them.");
  const agreeing = scored.filter((r) => r.verdict === r.label);
  const agreeingPassedOver = agreeing.filter((r) => r.kind === "passed-over").length;
  const kinds = {};
  for (const l of labels) kinds[l.label_kind] = (kinds[l.label_kind] ?? 0) + 1;
  return {
    label_provenance: "human",
    label_source: "github-record",
    description:
      "The owner's own recorded GitHub actions on each Scout proposal (approve label, merge of a build, decline label), read by scripts/judge/snapshot.mjs from data/judge/github-events.jsonl and pull-requests.jsonl. Made by the owner's account, not assigned by an LLM.",
    label_kinds: kinds,
    unambiguous_labels: labels.filter((l) => l.unambiguous).length,
    ambiguous_labels: labels.filter((l) => !l.unambiguous).length,
    explicit_rejections_in_record: labels.filter((l) => l.label_kind === "declined").length,
    unjudged,
    slices: {
      all_recorded_calls: all,
      explicit_calls_only: slice(
        explicit,
        "Only the owner's explicit acts: approve label, merged build, decline label. This repo's record has no explicit rejections, so every row here is an approval and the figure is how often the judge agrees with an approval (its approve rate on them). It cannot measure two-sided agreement, and kappa is undefined.",
      ),
      passed_over_only: slice(passedOver, "Only proposals the owner passed over. The figure is how often the judge also said 'not now' to them."),
      same_period: {
        filed_on_or_after: firstPassedOver,
        ...slice(samePeriod, "Proposals filed on or after the first passed-over one, so the approvals compared with the passed-over proposals come from the same weeks and the same triage."),
      },
    },
    reliance_on_passed_over: {
      agreements_total: agreeing.length,
      agreements_on_passed_over: agreeingPassedOver,
      share_of_agreement_from_passed_over: agreeing.length ? Math.round((agreeingPassedOver / agreeing.length) * 1000) / 1000 : null,
      reading:
        "How much of all_recorded_calls.agreement comes from counting passed-over proposals as 'not now'. If the owner would in fact have approved some of them, each one the judge held turns from an agreement into a disagreement.",
    },
    agreement_by_label_kind: byKind(scored),
    scout_bar_met_rate: barRates(scored, verdictById),
  };
}

function handBlock(handLabels, githubLabels, verdictById) {
  if (!handLabels.length) {
    return {
      label_provenance: "human",
      label_source: "hand-label",
      status: "no hand labels yet",
      how_to_add: "node scripts/judge/label.mjs, then node scripts/judge/evaluate.mjs",
    };
  }
  const { scored, unjudged } = score(handLabels, verdictById);
  const githubById = new Map(githubLabels.map((l) => [l.id, l]));
  const both = handLabels.filter((h) => githubById.has(h.id));
  const consistent = both.filter((h) => githubById.get(h.id).label === h.label);
  return {
    label_provenance: "human",
    label_source: "hand-label",
    description: "The owner's calls typed in with scripts/judge/label.mjs, blind to the judge and to the GitHub record. They are his call at the time he labelled, not in July 2026.",
    n: handLabels.length,
    labelers: [...new Set(handLabels.map((h) => h.decided_by))],
    unjudged,
    agreement: slice(scored, "Every hand-labelled proposal the judge answered."),
    hand_vs_github_record: {
      n: both.length,
      same_call: consistent.length,
      by_github_kind: Object.fromEntries(
        [...new Set(both.map((h) => githubById.get(h.id).label_kind))].map((k) => {
          const g = both.filter((h) => githubById.get(h.id).label_kind === k);
          return [k, { n: g.length, hand_says_approve: g.filter((h) => h.label === "approve").length }];
        }),
      ),
      reading: "Whether the owner's hand labels agree with what his recorded actions implied. Hand 'approve' on a passed-over proposal is direct evidence that passed-over was not a rejection.",
    },
  };
}

function pickVerdictsFile(argv) {
  const explicit = arg(argv, "verdicts");
  if (explicit) return path.resolve(ROOT, explicit);
  const preferred = verdictsPath();
  try {
    const files = readdirSync(VERDICTS_DIR).filter((f) => f.endsWith(".jsonl"));
    if (files.includes(path.basename(preferred))) return preferred;
  } catch {
    /* no answers recorded yet */
  }
  return preferred;
}

function main(argv) {
  const proposals = readJsonl(PROPOSALS_PATH);
  const githubLabels = loadLabels(GITHUB_LABELS_PATH);
  const handLabels = loadLabels(HAND_LABELS_PATH);

  const verdictsFile = pickVerdictsFile(argv);
  const verdicts = readJsonl(verdictsFile, { optional: true });
  const verdictById = new Map(verdicts.map((v) => [v.id, v]));
  const currentSha = judgePromptSha();
  const shas = [...new Set(verdicts.map((v) => v.prompt_sha256))];

  const out = {
    generated_by: "scripts/judge/evaluate.mjs",
    bootstrap: { reps: REPS, seed: SEED, interval: "95% percentile" },
    what_is_measured:
      "How often the proposal judge's call (approve / not now) matches the owner's own call on the same Scout proposal, made before any code was written for it.",
    golden_set: {
      proposals_file: rel(PROPOSALS_PATH),
      proposals: proposals.length,
      repo: proposals[0]?.repo ?? null,
      filed_between: [proposals.map((p) => p.filed_at).sort()[0] ?? null, proposals.map((p) => p.filed_at).sort().at(-1) ?? null],
      label_files: [rel(GITHUB_LABELS_PATH), rel(HAND_LABELS_PATH)],
      labels: "every label in this golden set is human-made; a label of any other provenance stops the run",
      note: "This is not data/gold-pairs-llm.jsonl. That file is a duplicate-detection set with LLM-assigned labels and is not used here.",
    },
    judge: verdicts.length
      ? {
          verdicts_file: rel(verdictsFile),
          answered: verdicts.length,
          model_requested: [...new Set(verdicts.map((v) => v.model_requested))],
          model_resolved: [...new Set(verdicts.map((v) => v.model_resolved))],
          prompt_version: [...new Set(verdicts.map((v) => v.prompt_version))],
          prompt_sha256: shas,
          prompt_matches_template: shas.length === 1 && shas[0] === currentSha,
          template_prompt_version: JUDGE_PROMPT_VERSION,
          cli: [...new Set(verdicts.map((v) => v.cli))],
          judged_between: [verdicts.map((v) => v.judged_at).sort()[0], verdicts.map((v) => v.judged_at).sort().at(-1)],
          verdict_matches_probability: Math.round((verdicts.filter((v) => (v.verdict === "approve") === (v.approve_probability >= 0.5)).length / verdicts.length) * 1000) / 1000,
          list_price_usd_total: Math.round(verdicts.reduce((s, v) => s + (v.list_price_usd ?? 0), 0) * 100) / 100,
        }
      : { status: "not yet run", how_to_run: "node scripts/judge/run-judge.mjs --live (spends one call per proposal)" },
    label_sets: verdicts.length
      ? {
          "github-record": githubRecordBlock(githubLabels, verdictById),
          "hand-label": handBlock(handLabels, githubLabels, verdictById),
        }
      : null,
    not_measured_here: [
      "The judge's effect on the agent PR merge rate. That needs the gate running in front of real builds; see metrics/merge-rate.json → post_gate.",
      "Agreement with explicit rejections: the recorded GitHub history has none (the declined label was never used on this repo).",
      "Whether cited code exists: the judge sees the proposal text only, as the gate does.",
    ],
  };

  mkdirSync(path.dirname(JUDGE_METRICS_PATH), { recursive: true });
  writeFileSync(JUDGE_METRICS_PATH, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${rel(JUDGE_METRICS_PATH)}.`);
  if (!verdicts.length) {
    console.log("No judge answers recorded yet, so no agreement figures. Run scripts/judge/run-judge.mjs --live first.");
    return;
  }
  if (!out.judge.prompt_matches_template) {
    console.log("::warning::These answers came from a different prompt than the template's current one; they do not describe the judge that ships now.");
  }
  const g = out.label_sets["github-record"].slices;
  const line = (name, s) =>
    `${name.padEnd(20)} n=${String(s.n).padStart(2)}  agreement ${s.agreement_count.padStart(5)} = ${s.agreement}  kappa ${s.cohen_kappa ?? "undefined"}  majority baseline ${s.majority_baseline.agreement}`;
  console.log(line("all recorded calls", g.all_recorded_calls));
  console.log(line("explicit calls only", g.explicit_calls_only));
  console.log(line("passed over only", g.passed_over_only));
  console.log(line("same period", g.same_period));
}

main(process.argv.slice(2));
