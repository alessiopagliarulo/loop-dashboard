/**
 * Shared plumbing for the proposal-judge harness: file locations, JSONL reading and
 * writing, and the repos the harness reads. See docs/judge-results.md.
 *
 * The recorded files under data/judge/ are the harness's default input, so every
 * number it reports can be recomputed offline, for free, from what is committed.
 * Only two scripts ever touch the network: snapshot.mjs --fetch (GitHub, read-only)
 * and run-judge.mjs --live (the model, on the owner's subscription).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_JUDGE_MODEL, JUDGE_PROMPT_VERSION } from "../../config/loop-template/files/loop-judge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
export const DATA_DIR = path.join(ROOT, "data", "judge");

/** Inputs to the judge. No labels in here, so the judge can never be shown one. */
export const PROPOSALS_PATH = path.join(DATA_DIR, "proposals.jsonl");
/** Each proposal's recorded label/close history: what the GitHub labels are read from. */
export const EVENTS_PATH = path.join(DATA_DIR, "github-events.jsonl");
/** Every PR in the baseline and target repos, reduced to what the counts need. */
export const PRS_PATH = path.join(DATA_DIR, "pull-requests.jsonl");
/** The owner's calls read off the GitHub record (derived from the two files above). */
export const GITHUB_LABELS_PATH = path.join(DATA_DIR, "labels-github.jsonl");
/** The owner's calls typed in by hand with label.mjs. Absent until he labels any. */
export const HAND_LABELS_PATH = path.join(DATA_DIR, "labels-hand.jsonl");
/** Recorded judge answers, one file per judge configuration. */
export const VERDICTS_DIR = path.join(DATA_DIR, "verdicts");

/** Where the answers of one judge configuration (model + prompt version) are recorded. */
export function verdictsPath(model = DEFAULT_JUDGE_MODEL, version = JUDGE_PROMPT_VERSION) {
  return path.join(VERDICTS_DIR, `${model}-prompt-v${version}.jsonl`);
}

export const JUDGE_METRICS_PATH = path.join(ROOT, "metrics", "judge-eval.json");
export const MERGE_METRICS_PATH = path.join(ROOT, "metrics", "merge-rate.json");

/** The template module the gate ships - the harness measures exactly this judge. */
export const LOOP_JUDGE_PATH = path.join(ROOT, "config", "loop-template", "files", "loop-judge.mjs");

/**
 * The repo the golden set comes from: the loop's first target, archived (read-only)
 * since 2026-09, so its record can no longer change under the numbers.
 */
export const BASELINE_REPO = "alessiopagliarulo/content-generation-platform";

/** Current targets, from the dashboard's own registry. */
export function targetRepos() {
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, "config", "projects.json"), "utf8"));
    return (cfg.projects ?? []).map((p) => `${p.owner}/${p.repo}`);
  } catch {
    return [];
  }
}

/** Rows of a JSONL file; `#` lines are the file's own header comments. */
export function readJsonl(file, { optional = false } = {}) {
  if (!existsSync(file)) {
    if (optional) return [];
    throw new Error(`${path.relative(ROOT, file)} does not exist`);
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ line: line.trim(), i }))
    .filter(({ line }) => line && !line.startsWith("#"))
    .map(({ line, i }) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${path.relative(ROOT, file)} line ${i + 1} is not valid JSON`);
      }
    });
}

/** Writes rows one per line under `#` header lines. Byte-identical for identical input. */
export function writeJsonl(file, header, rows) {
  const lines = [...header.map((h) => `# ${h}`), ...rows.map((r) => JSON.stringify(r))];
  writeFileSync(file, `${lines.join("\n")}\n`);
}

export function arg(argv, name, fallback = undefined) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

export function rel(file) {
  return path.relative(ROOT, file);
}
