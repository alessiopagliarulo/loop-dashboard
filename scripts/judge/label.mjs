#!/usr/bin/env node
/**
 * Hand-label the recorded Scout proposals, one keypress each, so the judge can be
 * measured against the owner's explicit calls instead of what his GitHub record implies.
 *
 *   node scripts/judge/label.mjs              then: node scripts/judge/evaluate.mjs
 *
 * One question per proposal: "Would you approve this for building, as written?"
 *   a = approve    n = not now    s = skip (asked again later)
 *   u = undo       f = show the full text    q = quit
 *
 * BLIND ON PURPOSE. It never shows the judge's answer or what the GitHub record says
 * happened to the proposal, and it asks in a shuffled order, so the label is the
 * owner's call on the text in front of him and nothing else.
 *
 * Saved to data/judge/labels-hand.jsonl after every answer, each row stamped
 * label_provenance "human" and label_source "hand-label"; re-running resumes where it
 * stopped. evaluate.mjs scores these as their own label set, never pooled with the
 * GitHub record, and reports how often the two agree.
 *
 * Flags: --labeler <name> (default: git user.name), --out <file>, --seed <n>.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

import { handLabel } from "../../lib/judge/golden.ts";
import { seededRng } from "../../lib/judge/metrics.ts";
import { HAND_LABELS_PATH, PROPOSALS_PATH, ROOT, arg, readJsonl, rel, writeJsonl } from "./_shared.mjs";

const argv = process.argv.slice(2);
const outPath = arg(argv, "out") ? path.resolve(ROOT, arg(argv, "out")) : HAND_LABELS_PATH;
const seed = Number(arg(argv, "seed", "20260923")) || 20260923;
const PREVIEW_CHARS = 2500;

function gitUser() {
  try {
    return execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
const labeler = arg(argv, "labeler") || gitUser() || "owner";

const proposals = readJsonl(PROPOSALS_PATH);
const byId = new Map(proposals.map((p) => [p.id, p]));
const labels = new Map(readJsonl(outPath, { optional: true }).map((l) => [l.id, l]));

// Fisher–Yates with a fixed seed: the same shuffled order every session.
const order = proposals.map((p) => p.id);
const rng = seededRng(seed);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
let queue = order.filter((id) => !labels.has(id));
const history = [];

function save() {
  const rows = [...labels.values()].sort((a, b) => a.number - b.number);
  writeJsonl(
    outPath,
    [
      "The owner's hand labels on recorded Scout proposals, written by scripts/judge/label.mjs.",
      "label_provenance human, label_source hand-label. Asked blind: no judge answer and no GitHub outcome was shown. Question: would you approve this for building, as written?",
    ],
    rows,
  );
}

function show(p, full = false) {
  const body = String(p.body ?? "");
  const text = full || body.length <= PREVIEW_CHARS ? body : `${body.slice(0, PREVIEW_CHARS)}\n\n[... ${body.length - PREVIEW_CHARS} more characters: press f to read all of it]`;
  console.log(`\n${"=".repeat(78)}\n[${labels.size + 1}/${proposals.length}]  #${p.number}  filed ${p.filed_at.slice(0, 10)}  ${p.url}\n\n${p.title}\n${"-".repeat(78)}\n${text}\n${"-".repeat(78)}`);
  console.log("Would you approve this for building, as written?   a = approve   n = not now   s = skip   u = undo   f = full text   q = quit");
}

function done() {
  save();
  console.log(`\n${labels.size} of ${proposals.length} labelled, saved to ${rel(outPath)}. Next: node scripts/judge/evaluate.mjs`);
  process.exit(0);
}

function next() {
  if (!queue.length) done();
  show(byId.get(queue[0]));
}

function answer(call) {
  const id = queue.shift();
  const p = byId.get(id);
  history.push(id);
  labels.set(id, handLabel({ id, label: call, labeled_at: new Date().toISOString(), labeler }, p.filed_at));
  save();
  next();
}

function onKey(ch) {
  if (ch === "a" || ch === "A") return answer("approve");
  if (ch === "n" || ch === "N") return answer("not-now");
  if (ch === "s" || ch === "S") {
    queue.push(queue.shift());
    return next();
  }
  if (ch === "f" || ch === "F") return show(byId.get(queue[0]), true);
  if (ch === "u" || ch === "U") {
    const last = history.pop();
    if (!last) {
      console.log("Nothing to undo yet.");
      return;
    }
    labels.delete(last);
    save();
    queue = [last, ...queue.filter((id) => id !== last)];
    return next();
  }
  if (ch === "q" || ch === "Q" || ch === "\u0003") return done();
}

if (!process.stdin.isTTY && !argv.includes("--allow-no-tty")) {
  console.error(
    `This labeller needs a real terminal: stdin is not one, so it would record nothing.\nOpen Terminal and run:\n\n  cd ${JSON.stringify(ROOT)} && node scripts/judge/label.mjs\n`,
  );
  process.exit(2);
}

console.log(`Labelling as "${labeler}". ${labels.size} already labelled, ${queue.length} to go. Everything is saved after each answer.`);
next();
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const ch of chunk) onKey(ch);
});
process.stdin.on("end", done);
