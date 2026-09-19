#!/usr/bin/env node
/**
 * Interactive, resumable hand-labelling CLI for the dedup gold set.
 *
 * Reads data/gold-pairs-unlabeled.jsonl, shows one candidate pair at a time,
 * and writes data/gold-pairs.jsonl after EVERY single keypress answer — a
 * crash or Ctrl-C never loses more than the answer in progress (there is
 * none in progress between prompts: the file on disk is always caught up).
 *
 * Resumable: on start it reads any existing data/gold-pairs.jsonl, keeps
 * every already-valid label, and only asks about what's left.
 *
 * Single-keypress controls, shown on every prompt:
 *   1 = duplicate   2 = related   3 = unrelated
 *   s = skip for now (comes back later this session)
 *   u = undo last answer
 *   q = quit and save
 *
 * Order: hardest/most-informative strata first, so a partial session (say
 * 40-60 of 150 rows) still covers the pairs that matter most for
 * evaluate.mjs's precision-first threshold. See STRATUM_PRIORITY below.
 *
 * This file only READS scripts/ml/_shared.mjs — it does not modify it, nor
 * evaluate.mjs, compare-encoders.mjs or build-index.mjs.
 *
 * Usage:
 *   node scripts/ml/label.mjs
 *   node scripts/ml/label.mjs --unlabeled=path/to/unlabeled.jsonl --gold=path/to/out.jsonl
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

import { ROOT, UNLABELED_PATH, LABELED_PATH, LABELS } from "./_shared.mjs";

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const unlabeledPath = arg("unlabeled", null) ? path.resolve(arg("unlabeled")) : UNLABELED_PATH;
const goldPath = arg("gold", null) ? path.resolve(arg("gold")) : LABELED_PATH;

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** Split a .jsonl file into its leading `#` comment block and its data rows. */
function readJsonlWithHeader(file) {
  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n");
  const header = [];
  const rows = [];
  let inHeader = true;
  for (const rawLine of lines) {
    const l = rawLine.trim();
    if (!l) continue;
    if (l.startsWith("#")) {
      if (inHeader) header.push(rawLine.replace(/\s+$/, ""));
      continue;
    }
    inHeader = false;
    rows.push(JSON.parse(l));
  }
  return { header, rows };
}

const key = (r) => `${r.a}:${r.b}`;

function hasValidLabel(row) {
  return LABELS.includes(row.label);
}

if (!existsSync(unlabeledPath)) {
  console.error(`Cannot find ${unlabeledPath}. Run scripts/ml/generate-pairs.mjs first.`);
  process.exit(1);
}

const { header: sourceHeader, rows: sourceRows } = readJsonlWithHeader(unlabeledPath);
if (sourceRows.length === 0) {
  console.error(`${unlabeledPath} has no data rows.`);
  process.exit(1);
}

let header = sourceHeader;
let existing = new Map();
if (existsSync(goldPath)) {
  const parsed = readJsonlWithHeader(goldPath);
  if (parsed.header.length) header = parsed.header;
  for (const r of parsed.rows) existing.set(key(r), r);
}

// Canonical row list: source order, source fields, but label/notes carried
// over from any existing gold file. This is what gets written to disk.
const rows = sourceRows.map((r) => {
  const prior = existing.get(key(r));
  return {
    ...r,
    label: prior && hasValidLabel(prior) ? prior.label : "",
    notes: prior && prior.notes ? prior.notes : r.notes ?? "",
  };
});

/* ------------------------------------------------------------------ */
/* Persistence — rewrite the whole file, atomically, after every answer */
/* ------------------------------------------------------------------ */

function save() {
  const lines = [...header, ...rows.map((r) => JSON.stringify(r))];
  const tmp = `${goldPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${lines.join("\n")}\n`, "utf-8");
  renameSync(tmp, goldPath);
}

/* ------------------------------------------------------------------ */
/* Ordering — hardest / most informative strata first                  */
/* ------------------------------------------------------------------ */

// dense_only: the pairs the dense model ranks highest specifically OUTSIDE
// the lexical top 400 — by construction, the pairs where dense and lexical
// disagree most. lex_top: the highest raw-overlap pairs in the corpus,
// where the real duplicates concentrate. Both are census strata (not random
// samples), so every row in them is maximally informative. The random
// strata (lex_high/mid/low) are progressively less likely to contain
// anything but easy unrelated pairs, so they come last.
const STRATUM_PRIORITY = ["dense_only", "lex_top", "lex_high", "lex_mid", "lex_low"];

function stratumRank(s) {
  const i = STRATUM_PRIORITY.indexOf(s);
  return i === -1 ? STRATUM_PRIORITY.length : i;
}

const order = rows
  .map((r, i) => i)
  .sort((ia, ib) => {
    const ra = stratumRank(rows[ia].stratum);
    const rb = stratumRank(rows[ib].stratum);
    if (ra !== rb) return ra - rb;
    return ia - ib; // stable: preserve the file's seeded-shuffled order within a stratum
  });

/* ------------------------------------------------------------------ */
/* Session state                                                       */
/* ------------------------------------------------------------------ */

const total = rows.length;
const alreadyLabelled = rows.filter(hasValidLabel).length;

// The working queue holds indices-into-`order` positions... simplest: a
// queue of row indices (into `rows`) still needing a label, in priority
// order. Skip moves an item to the back; answering removes it.
let queue = order.filter((i) => !hasValidLabel(rows[i]));
let pos = 0;

const history = []; // stack of { idx, prevLabel, prevNotes } for 'u'

function counts() {
  const c = { duplicate: 0, related: 0, unrelated: 0 };
  for (const r of rows) if (hasValidLabel(r)) c[r.label] += 1;
  return c;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const isTTY = !!process.stdout.isTTY;
const bold = (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const yellow = (s) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const cyan = (s) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s);
const green = (s) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);

const HARD_STRATA = new Set(["dense_only", "lex_top"]);

// Titles alone are often too thin to judge a pair, so pull the real issue/PR
// body out of the corpus and show an excerpt. Keyed by `${type}#${number}`.
const docByKey = (() => {
  const map = new Map();
  const corpusPath = path.join(ROOT, "data", "corpus.jsonl");
  if (!existsSync(corpusPath)) return map;
  for (const line of readFileSync(corpusPath, "utf-8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    try {
      const doc = JSON.parse(line);
      map.set(`${doc.type}#${doc.number}`, doc);
    } catch {
      // A malformed corpus line costs us one excerpt, not the session.
    }
  }
  return map;
})();

// Whether each side shipped is one of the strongest signals available: two
// merged PRs are almost never the same work, because you would not merge the
// same change twice.
function statusLine(doc) {
  if (!doc) return "";
  const when = String(doc.created_at ?? "").slice(0, 10);
  let state;
  if (doc.merged_at) state = green("MERGED");
  else if (doc.state === "closed") state = yellow("closed, not merged");
  else state = cyan("still open");
  return `${state}${when ? dim(`, filed ${when}`) : ""}`;
}

// Markdown headings, bullets and code fences add noise at this width; strip to
// prose so the excerpt spends its characters on meaning.
function excerpt(body, limit) {
  const clean = String(body ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return dim("(no description)");
  return clean.length <= limit ? clean : `${clean.slice(0, limit).trimEnd()}…`;
}

function wrap(text, width, indent) {
  const out = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + word.length + 1 > width) {
      out.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(indent + line);
  return out.join("\n");
}

// Toggled with `b` — full text when a pair genuinely needs it.
let showFullBody = false;

function fmtSide(label, num, type, title, url) {
  const doc = docByKey.get(`${type}#${num}`);
  const text = excerpt(doc?.body, showFullBody ? 6000 : 850);
  const status = statusLine(doc);
  return (
    `  ${bold(label)} [${type.toUpperCase()} #${num}]  ${status}\n    ${bold(title)}\n` +
    `${wrap(text, 68, "      ")}\n    ${dim(url)}`
  );
}

function renderPrompt(row) {
  const c = counts();
  const done = c.duplicate + c.related + c.unrelated;
  const remaining = total - done;

  console.log("");
  console.log("=".repeat(72));
  const hardTag = HARD_STRATA.has(row.stratum) ? yellow(" [HARD — methods likely disagree]") : "";
  console.log(
    `${bold(`stratum: ${row.stratum}`)}${hardTag}   ${dim(`(remaining in queue: ${remaining})`)}`,
  );
  console.log("-".repeat(72));
  console.log(fmtSide("A:", row.a, row.a_type, row.a_title, row.a_url));
  console.log(fmtSide("B:", row.b, row.b_type, row.b_title, row.b_url));
  console.log("-".repeat(72));
  const s = row.scores ?? {};
  console.log(
    `  scores:  overlap=${s.overlap ?? "?"}   overlap_norm=${
      s.overlap_norm != null ? s.overlap_norm.toFixed(4) : "?"
    }   bm25=${s.bm25 != null ? s.bm25.toFixed(2) : "?"}   dense=${
      s.dense != null ? s.dense.toFixed(4) : "?"
    }`,
  );
  console.log("-".repeat(72));
  console.log(dim("  ask: if I do A, do I still need to do B?"));
  console.log(
    `  ${green("1")}=no, B is pointless   ${green("2")}=yes, but same feature   ${green(
      "3",
    )}=yes, unrelated work`,
  );
  console.log(
    `  ${cyan("s")}=skip  ${cyan("u")}=undo  ${cyan("b")}=${
      showFullBody ? "shorter text" : "FULL text"
    }  ${cyan("q")}=quit&save`,
  );
  console.log(
    `  labelled ${done} / ${total} — ${c.duplicate} duplicate, ${c.related} related, ${c.unrelated} unrelated`,
  );
  process.stdout.write("  > ");
}

function printBanner() {
  console.log(bold("Dedup gold-set labeller"));
  console.log(`  source: ${path.relative(ROOT, unlabeledPath)}`);
  console.log(`  output: ${path.relative(ROOT, goldPath)}  (saved after every answer)`);
  console.log(
    `  order: ${STRATUM_PRIORITY.join(" -> ")}  (dense_only and lex_top are the hardest, ` +
      `most informative pairs — census strata where dense and lexical disagree most, or ` +
      `where the real duplicates concentrate. If you stop early, these are the ones that counted.)`,
  );
  if (alreadyLabelled > 0) {
    console.log(
      green(
        `  ${alreadyLabelled} of ${total} already labelled, resuming at row ${alreadyLabelled + 1}.`,
      ),
    );
  } else {
    console.log(`  0 of ${total} labelled yet — starting from the top of the priority order.`);
  }
}

function printSummaryAndExit() {
  const c = counts();
  const done = c.duplicate + c.related + c.unrelated;
  console.log("");
  console.log("=".repeat(72));
  console.log(bold("Saved."));
  console.log(
    `  ${done} / ${total} labelled — ${c.duplicate} duplicate, ${c.related} related, ${c.unrelated} unrelated`,
  );
  if (done < total) {
    console.log(`  ${total - done} left. Run this again to pick up right where you stopped:`);
    console.log(`    node scripts/ml/label.mjs`);
  } else {
    console.log(green("  All rows labelled. Next:"));
    console.log(`    node scripts/ml/evaluate.mjs`);
  }
  console.log("=".repeat(72));
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Input handling — one keypress, no Enter required on a real terminal */
/* ------------------------------------------------------------------ */

function currentRow() {
  while (pos < queue.length && hasValidLabel(rows[queue[pos]])) {
    // Defensive: something upstream already labelled this row (shouldn't
    // happen in normal flow, but keeps the queue honest if it does).
    queue.splice(pos, 1);
  }
  if (pos >= queue.length) return null;
  return rows[queue[pos]];
}

function promptNext() {
  const row = currentRow();
  if (!row) {
    printSummaryAndExit();
    return;
  }
  renderPrompt(row);
}

const LABEL_FOR_KEY = { 1: "duplicate", 2: "related", 3: "unrelated" };

function handleKey(ch) {
  const row = currentRow();
  if (!row) return; // already exiting

  if (ch === "1" || ch === "2" || ch === "3") {
    const idx = queue[pos];
    history.push({ idx, prevLabel: row.label, prevNotes: row.notes });
    row.label = LABEL_FOR_KEY[ch];
    save();
    queue.splice(pos, 1); // answered — leave the queue, don't advance pos
    promptNext();
    return;
  }

  if (ch === "b" || ch === "B") {
    showFullBody = !showFullBody;
    renderPrompt(row);
    return;
  }

  if (ch === "s" || ch === "S") {
    const idx = queue.splice(pos, 1)[0];
    queue.push(idx); // revisit after everything else in this session
    promptNext();
    return;
  }

  if (ch === "u" || ch === "U") {
    const last = history.pop();
    if (!last) {
      console.log(yellow("  nothing to undo yet."));
      renderPrompt(row);
      return;
    }
    const target = rows[last.idx];
    target.label = last.prevLabel;
    target.notes = last.prevNotes;
    save();
    // Put it back at the front of the queue so it's asked again right away.
    const already = queue.indexOf(last.idx);
    if (already !== -1) queue.splice(already, 1);
    queue.splice(pos, 0, last.idx);
    console.log(yellow(`  undone. re-showing pair ${target.a}/${target.b}.`));
    promptNext();
    return;
  }

  if (ch === "q" || ch === "Q") {
    save();
    printSummaryAndExit();
    return;
  }

  // Unrecognised key (includes bare newlines from piped input) — ignore
  // silently and re-render so a stray keystroke never looks like a hang.
  if (ch === "\r" || ch === "\n" || ch === "") return;
  console.log(yellow(`  "${ch}" isn't a valid key. Use 1, 2, 3, s, u, or q.`));
  renderPrompt(row);
}

function main() {
  // Without a terminal on stdin there is nobody to press a key: input hits EOF
  // immediately and we would "save" zero labels and exit looking successful.
  // Refuse loudly instead. --allow-no-tty is the escape hatch for test harnesses
  // that legitimately pipe keystrokes in.
  if (!process.stdin.isTTY && !process.argv.includes("--allow-no-tty")) {
    console.error(
      [
        "",
        "  This labeller needs a real terminal — stdin is not a TTY, so it would",
        "  read end-of-input straight away and record nothing.",
        "",
        "  Open Terminal and run:",
        "",
        `    cd ${JSON.stringify(process.cwd())} && node scripts/ml/label.mjs`,
        "",
        "  (Running it through a pipe, or via Claude Code's ! prefix, hits this.)",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }

  printBanner();

  if (queue.length === 0) {
    printSummaryAndExit();
    return;
  }

  promptNext();

  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding("utf-8");
  stdin.resume();

  stdin.on("data", (chunk) => {
    for (const ch of chunk) {
      if (ch === "") {
        // Ctrl-C: everything is already saved after the last answer; say so
        // and exit cleanly instead of a bare kill.
        save();
        console.log("\n  interrupted — already saved.");
        printSummaryAndExit();
        return;
      }
      handleKey(ch);
    }
  });

  stdin.on("end", () => {
    // Piped input ran out (e.g. a test harness). Save and report as if quit.
    save();
    printSummaryAndExit();
  });
}

process.on("SIGINT", () => {
  save();
  console.log("\n  interrupted — already saved.");
  printSummaryAndExit();
});

main();
