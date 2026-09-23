#!/usr/bin/env node
/**
 * Counts the agent PR merge rate from the recorded PRs → metrics/merge-rate.json.
 *
 *   node scripts/judge/merge-rate.mjs            offline, from data/judge/pull-requests.jsonl
 *
 * To count the latest state of the current targets, re-record first:
 *   node scripts/judge/snapshot.mjs --fetch && node scripts/judge/merge-rate.mjs
 *
 * Three things, all counted, none modelled:
 *   baseline       the archived first target, under every counting rule the historic
 *                  figures could have come from, each rule stated in words;
 *   current        the same rules on the targets the dashboard runs today;
 *   post_gate      loop PRs built from proposals the judge gate scored first. Until the
 *                  gate has run in front of real builds this is n = 0 and says "not
 *                  measured". Nothing here estimates it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BASELINE_RULES, PROPOSAL_BUILD_RULE, applyRule, postGate } from "../../lib/judge/merge-rate.ts";
import { BASELINE_REPO, MERGE_METRICS_PATH, PRS_PATH, readJsonl, rel } from "./_shared.mjs";

/** Figures quoted before this harness existed, checked against the rules above. */
const HISTORIC_FIGURES = [
  { figure: "46%", as: "22 of 48 agent PRs" },
  { figure: "63% of resolved", as: "22 of 35" },
];

function rulesFor(prs) {
  return [...BASELINE_RULES, PROPOSAL_BUILD_RULE].map((rule) => applyRule(rule, prs));
}

function main() {
  const prs = readJsonl(PRS_PATH);
  const repos = [...new Set(prs.map((p) => p.repo))];
  const baselinePrs = prs.filter((p) => p.repo === BASELINE_REPO);
  const baselineRules = rulesFor(baselinePrs);

  const reproduced = HISTORIC_FIGURES.map((h) => {
    const [merged, of] = h.as.match(/\d+/g).map(Number);
    const match = baselineRules.find((r) => r.merged === merged && r.denominator === of);
    return { ...h, reproduced_by: match ? match.id : null };
  });

  const out = {
    generated_by: "scripts/judge/merge-rate.mjs",
    recorded_prs_file: rel(PRS_PATH),
    what_is_counted: "Merged pull requests over pull requests, for PRs the loop's agents opened. Every rule is stated; none is the headline.",
    baseline: {
      repo: BASELINE_REPO,
      note: "The loop's first target, archived since 2026-09, so these counts no longer change. It ran before any judge gate existed.",
      rules: baselineRules.filter((r) => r.id !== PROPOSAL_BUILD_RULE.id),
      comparison_for_post_gate: baselineRules.find((r) => r.id === PROPOSAL_BUILD_RULE.id),
      historic_figures: reproduced,
      historic_figures_reading:
        "No counting rule over the recorded PRs reproduces 46% (22 of 48) or 22 of 35: the loop's own PRs give 20 of 47, and counting every claude/ branch gives 22 of 49. The 46% figure is not reproducible from the data.",
    },
    current_targets: repos
      .filter((r) => r !== BASELINE_REPO)
      .map((repo) => ({ repo, rules: rulesFor(prs.filter((p) => p.repo === repo)) })),
    post_gate: {
      ...postGate(prs),
      repos_checked: repos,
      reading:
        "Counted from real PRs only: loop PRs that build a proposal the judge gate had already scored when the PR was opened. The gate ships off by default (judge.enabled in each target's .github/loop-config.json), so this stays at n = 0 until an owner turns it on and the Builder opens PRs after that. It is not estimated, modelled or extrapolated, and no before/after improvement can be quoted until it is measured.",
    },
  };
  if (!out.post_gate.measured) out.post_gate.status = "not yet measured";

  mkdirSync(path.dirname(MERGE_METRICS_PATH), { recursive: true });
  writeFileSync(MERGE_METRICS_PATH, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${rel(MERGE_METRICS_PATH)}.`);
  for (const r of baselineRules) console.log(`  baseline ${r.id.padEnd(30)} ${r.count.padStart(6)} = ${r.rate}  (${r.open} still open)`);
  for (const t of out.current_targets) for (const r of t.rules) console.log(`  ${t.repo.split("/")[1]} ${r.id.padEnd(30)} ${r.count.padStart(6)} = ${r.rate}`);
  console.log(`  post-gate: ${out.post_gate.measured ? `${out.post_gate.count} = ${out.post_gate.rate}` : "not yet measured (n = 0)"}`);
}

main();
