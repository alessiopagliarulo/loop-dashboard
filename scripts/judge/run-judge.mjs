#!/usr/bin/env node
/**
 * Runs the proposal judge over the recorded proposals and records its answers.
 *
 *   node scripts/judge/run-judge.mjs                 prints what a live run would do; calls nothing
 *   node scripts/judge/run-judge.mjs --live          judges every proposal not yet judged
 *
 * THIS IS THE ONLY SCRIPT IN THE HARNESS THAT SPENDS ANYTHING. Each proposal is one
 * call through the local `claude` CLI, on the owner's subscription. Everything else
 * (evaluate.mjs, merge-rate.mjs) reads the answers recorded here and is free to re-run,
 * which is why the answers are committed.
 *
 * It judges each proposal once. Answers are appended as they arrive, so an interrupted
 * run resumes where it stopped and never pays twice for the same proposal; a proposal
 * whose call failed is left out (and named), never guessed.
 *
 * The judge is imported from config/loop-template/files/loop-judge.mjs - the module
 * the gate ships - so what is measured here is exactly what runs in a target repo:
 * same prompt, same schema, same isolated CLI call. The judge is shown the proposal's
 * title and body and nothing else: the labels live in other files, and this script
 * never opens them.
 *
 * Flags: --model <alias> (default: the gate's default), --concurrency <n> (default 3),
 * --limit <n> (judge at most n more).
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

import {
  DEFAULT_JUDGE_MODEL,
  JUDGE_PROMPT_VERSION,
  judgePromptSha,
  resolveCli,
  runJudge,
} from "../../config/loop-template/files/loop-judge.mjs";
import { PROPOSALS_PATH, VERDICTS_DIR, arg, readJsonl, rel, verdictsPath, writeJsonl } from "./_shared.mjs";

function cliVersion(cli) {
  try {
    return execFileSync(cli.cmd, [...cli.prefix, "--version"], { encoding: "utf8", timeout: 60_000 }).trim();
  } catch {
    return null;
  }
}

async function main(argv) {
  const live = argv.includes("--live");
  const model = arg(argv, "model", DEFAULT_JUDGE_MODEL);
  const concurrency = Math.max(1, Math.min(6, Number(arg(argv, "concurrency", "3")) || 3));
  const limit = Number(arg(argv, "limit", "0")) || Infinity;
  const out = verdictsPath(model);
  const proposals = readJsonl(PROPOSALS_PATH);
  const done = new Set(readJsonl(out, { optional: true }).map((v) => v.id));
  const todo = proposals.filter((p) => !done.has(p.id)).slice(0, limit);

  console.log(
    `${proposals.length} recorded proposals, ${done.size} already judged in ${rel(out)}, ${todo.length} to judge.\n` +
      `Judge: model ${model}, prompt v${JUDGE_PROMPT_VERSION} (sha256 ${judgePromptSha().slice(0, 16)}…).`,
  );
  if (!live) {
    console.log(`Dry run: nothing called. Add --live to make ${todo.length} call(s) on the owner's subscription.`);
    return;
  }
  if (todo.length === 0) return;

  const cli = resolveCli();
  const cliVer = cliVersion(cli);
  mkdirSync(VERDICTS_DIR, { recursive: true });
  if (!existsSync(out)) {
    writeJsonl(
      out,
      [
        `Proposal judge answers: model ${model}, prompt v${JUDGE_PROMPT_VERSION}, recorded by scripts/judge/run-judge.mjs --live.`,
        "One call per proposal through the claude CLI (isolated: own system prompt, no tools, safe mode). The judge saw only each proposal's title and body.",
      ],
      [],
    );
  }

  const failed = [];
  let next = 0;
  let finished = 0;
  async function worker() {
    while (next < todo.length) {
      const p = todo[next++];
      try {
        const r = await runJudge({ repo: p.repo, title: p.title, body: p.body, model, cli });
        const row = {
          id: p.id,
          number: p.number,
          verdict: r.verdict,
          approve_probability: r.approve_probability,
          bar: r.bar,
          reasons: r.reasons,
          ...r.meta,
          cli: cliVer,
          judged_at: new Date().toISOString(),
        };
        appendFileSync(out, `${JSON.stringify(row)}\n`);
        finished++;
        console.log(`[${finished}/${todo.length}] #${p.number} ${r.verdict} (p=${r.approve_probability}) ${r.meta.model_resolved ?? ""}`);
      } catch (err) {
        failed.push(p.id);
        console.log(`#${p.number} FAILED, not recorded: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  // Same file, sorted by proposal number, so a resumed run and a clean run look alike.
  const rows = readJsonl(out).sort((a, b) => a.number - b.number);
  writeJsonl(
    out,
    [
      `Proposal judge answers: model ${model}, prompt v${JUDGE_PROMPT_VERSION}, recorded by scripts/judge/run-judge.mjs --live.`,
      "One call per proposal through the claude CLI (isolated: own system prompt, no tools, safe mode). The judge saw only each proposal's title and body.",
    ],
    rows,
  );
  console.log(`${rows.length} answers in ${rel(out)}.${failed.length ? ` Failed (re-run --live to retry only these): ${failed.join(", ")}` : ""}`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
