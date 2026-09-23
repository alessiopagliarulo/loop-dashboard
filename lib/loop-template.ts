/**
 * The editable NEW-PROJECT TEMPLATE.
 *
 * What gets installed into a brand-new project used to be a live snapshot of
 * the pilot repo. Now it's a real, editable set of files stored in THIS
 * dashboard repo under config/loop-template/, read and written through the
 * GitHub API (same pattern as config/projects.json). Two sections:
 *
 *   config/loop-template/workflows/  — the .github/workflows/*.yml agents
 *   config/loop-template/files/      — every OTHER baseline file (.mcp.json,
 *                                      DASHBOARD-CONTRACT.md, loop-brief.md,
 *                                      loop-metrics.mjs, loop-inflight.mjs,
 *                                      loop-models.json).
 *                                      Flat filenames; where each one installs
 *                                      in a target repo is declared by
 *                                      TEMPLATE_FILE_TARGETS.
 *
 * The template is now the SINGLE source of truth for a new project. Onboarding
 * reads it and nothing else — there is deliberately no pilot fallback, because
 * a silent fallback let pilot-specific state leak into new projects.
 *
 * - `listTemplateWorkflows` / `listTemplateFiles` are what onboarding reads.
 * - `seedTemplateFromPilot` initializes the workflows section ONCE by copying
 *   the pilot's current workflows.
 * - `applyTemplateChanges` commits AI-drafted template edits (modify, add, or
 *   remove files in either section) as one commit to the dashboard repo.
 * - `computeTemplateDrift` compares the template's workflows against one
 *   project's live .github/workflows/ (read-only) for the drift endpoint.
 */

import { createHash } from "node:crypto";
import { getFileContent, getOctokit, type RepoConfig } from "./github";
import { atomicCommit, snapshotWorkflows, type TreeChange } from "./map-history";
import { DASHBOARD_REPO, PILOT_PROJECT } from "./projects";

export const TEMPLATE_DIR = "config/loop-template";
export const TEMPLATE_WORKFLOWS_DIR = `${TEMPLATE_DIR}/workflows`;
export const TEMPLATE_FILES_DIR = `${TEMPLATE_DIR}/files`;

/** The two halves of the template. */
export type TemplateSection = "workflows" | "files";

/**
 * Where each non-workflow template file installs inside a target repo.
 * The template stores them flat (one directory, no nesting) so they stay easy
 * to list and edit; this map is the only thing that knows the destination.
 * A file in config/loop-template/files/ with no entry here is ignored by
 * onboarding — add it here to make it part of the baseline.
 */
export const TEMPLATE_FILE_TARGETS: Record<string, string> = {
  ".mcp.json": ".mcp.json",
  "DASHBOARD-CONTRACT.md": "docs/DASHBOARD-CONTRACT.md",
  "loop-brief.md": "docs/loop-brief.md",
  "loop-metrics.mjs": "scripts/loop-metrics.mjs",
  "loop-inflight.mjs": "scripts/loop-inflight.mjs",
  // The models an agent may be switched to - see lib/loop-models.ts.
  "loop-models.json": ".github/loop-models.json",
};

const PILOT_REPO: RepoConfig = { owner: PILOT_PROJECT.owner, repo: PILOT_PROJECT.repo };

/** Error carrying the HTTP status a route should surface for it. */
export class TemplateError extends Error {
  constructor(
    message: string,
    public httpStatus: number = 400,
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Workflow filenames only — no paths, no traversal, YAML only. */
export function isValidTemplateFileName(file: string): boolean {
  return /^[A-Za-z0-9._-]+\.ya?ml$/.test(file);
}

/**
 * Non-workflow template filenames: a single flat name, any extension, a
 * leading dot allowed (`.mcp.json`) but never `.`, `..` or a path.
 */
export function isValidTemplateAssetName(file: string): boolean {
  if (file === "." || file === ".." || file.includes("/") || file.includes("\\")) return false;
  return /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file);
}

/** The directory + name rule for one section of the template. */
export function templateSection(section: TemplateSection): {
  dir: string;
  isValidName: (file: string) => boolean;
} {
  return section === "files"
    ? { dir: TEMPLATE_FILES_DIR, isValidName: isValidTemplateAssetName }
    : { dir: TEMPLATE_WORKFLOWS_DIR, isValidName: isValidTemplateFileName };
}

/**
 * Map of filename → content for one template directory. Empty map when the
 * directory doesn't exist yet (or was emptied out).
 */
async function readTemplateDir(
  dir: string,
  isValidName: (file: string) => boolean,
): Promise<Map<string, string>> {
  const octokit = getOctokit();
  const out = new Map<string, string>();
  let entries: { type: string; name: string; path: string }[];
  try {
    const res = await octokit.rest.repos.getContent({
      owner: DASHBOARD_REPO.owner,
      repo: DASHBOARD_REPO.repo,
      path: dir,
    });
    if (!Array.isArray(res.data)) return out;
    entries = res.data;
  } catch (err: unknown) {
    if ((err as { status?: number })?.status === 404) return out; // not seeded yet
    throw err;
  }

  await Promise.all(
    entries
      .filter((e) => e.type === "file" && isValidName(e.name))
      .map(async (e) => {
        const file = await octokit.rest.repos.getContent({
          owner: DASHBOARD_REPO.owner,
          repo: DASHBOARD_REPO.repo,
          path: e.path,
        });
        if (!Array.isArray(file.data) && file.data.type === "file" && "content" in file.data) {
          out.set(e.name, Buffer.from(file.data.content, "base64").toString("utf-8"));
        }
      }),
  );
  return out;
}

/**
 * Map of workflow filename → content for the template. Empty map when the
 * template hasn't been seeded yet (or was emptied out).
 */
export async function listTemplateWorkflows(): Promise<Map<string, string>> {
  return readTemplateDir(TEMPLATE_WORKFLOWS_DIR, isValidTemplateFileName);
}

/**
 * Map of template filename → content for the non-workflow baseline files.
 * Only files with a declared destination (TEMPLATE_FILE_TARGETS) are returned,
 * so a stray file in the directory can never be installed somewhere unknown.
 */
export async function listTemplateFiles(): Promise<Map<string, string>> {
  const all = await readTemplateDir(TEMPLATE_FILES_DIR, isValidTemplateAssetName);
  for (const name of [...all.keys()]) {
    if (!(name in TEMPLATE_FILE_TARGETS)) all.delete(name);
  }
  return all;
}

/**
 * A short hash of one template file's exact content.
 *
 * The editor loads a file, the owner types into it for a while, and saves.
 * Without a base-version check that save is a blind overwrite of whatever the
 * file has become in the meantime. The editor sends back the hash it opened;
 * a mismatch is a 409 rather than a silent clobber.
 */
export function templateContentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

/** One template file's current content, or `null` if it isn't there. */
export async function readTemplateFile(
  section: TemplateSection,
  file: string,
): Promise<string | null> {
  const { dir } = templateSection(section);
  return getFileContent(`${dir}/${file}`, undefined, DASHBOARD_REPO);
}

export type SeedResult = {
  /** True when the template already existed and nothing was done. */
  alreadySeeded: boolean;
  files: string[];
  commitUrl?: string;
};

/**
 * Initialize the WORKFLOWS section of the template ONCE by copying the pilot
 * project's current workflow files into config/loop-template/workflows/. A
 * no-op (and safe to call again) when the template already has files.
 *
 * The `files/` section is NOT seeded from the pilot — its contents are checked
 * into this repo by hand precisely so pilot-specific state can't propagate.
 */
export async function seedTemplateFromPilot(): Promise<SeedResult> {
  const existing = await listTemplateWorkflows();
  if (existing.size > 0) {
    return { alreadySeeded: true, files: [...existing.keys()].sort() };
  }

  let workflows: Map<string, string>;
  try {
    workflows = await snapshotWorkflows("main", PILOT_REPO);
  } catch (err) {
    console.error("loop-template: pilot snapshot failed", err);
    throw new TemplateError(
      "Couldn't read the pilot project's workflows to copy from. Try again.",
      502,
    );
  }
  if (workflows.size === 0) {
    throw new TemplateError("The pilot project has no workflow files to copy.", 502);
  }

  const changes: TreeChange[] = [...workflows.entries()].map(([name, content]) => ({
    path: `${TEMPLATE_WORKFLOWS_DIR}/${name}`,
    content,
  }));
  const res = await atomicCommit(
    changes,
    "dashboard: seed the new-project template from the pilot",
    DASHBOARD_REPO,
  );
  return { alreadySeeded: false, files: [...workflows.keys()].sort(), commitUrl: res.url };
}

export type TemplateFileEdit = {
  /** Filename only, e.g. "claude-scout.yml" or "loop-brief.md". */
  file: string;
  /** New content, or null to remove the file from the template. */
  newContent: string | null;
  /** Which half of the template `file` lives in. Defaults to "workflows". */
  section?: TemplateSection;
  /**
   * The {@link templateContentHash} of the content the editor opened. When
   * given, the save is rejected (409) if the stored file has changed since.
   * Omit for a blind write (the AI editor, which fetches its own fresh copy
   * immediately before drafting).
   */
  expectedHash?: string;
};

/** The message the UI shows when a save loses a base-version check. */
const STALE_EDIT_MESSAGE =
  "This file changed since you opened it — reopen to get the latest.";

/**
 * Commit a set of template edits (modify / add / remove files in either
 * section) as ONE commit to the dashboard repo. Throws {@link TemplateError}
 * with a plain-English message for every expected failure.
 */
export async function applyTemplateChanges(
  edits: TemplateFileEdit[],
  summary: string,
): Promise<{ commitUrl: string }> {
  if (edits.length === 0) throw new TemplateError("No changes to apply.");
  const changes: TreeChange[] = [];
  for (const e of edits) {
    const file = (e.file ?? "").trim();
    const section = e.section ?? "workflows";
    const { dir, isValidName } = templateSection(section);
    if (!isValidName(file)) {
      throw new TemplateError(`Invalid file name: ${file || "(empty)"}`);
    }
    if (e.newContent !== null && e.newContent.trim() === "") {
      throw new TemplateError(`Empty content for ${file}.`);
    }
    // A files-section file with no entry in TEMPLATE_FILE_TARGETS is invisible
    // to onboarding — listTemplateFiles drops it, so it would never install
    // anywhere. Writing one looks like it worked and silently does nothing, so
    // reject it here rather than on the read side only. (Removals are allowed:
    // deleting a stray file is exactly how you'd clean one up.)
    if (section === "files" && e.newContent !== null && !(file in TEMPLATE_FILE_TARGETS)) {
      throw new TemplateError(
        `${file} isn't one of the starting files a new project gets, so saving it would have no effect. The starting files are: ${Object.keys(
          TEMPLATE_FILE_TARGETS,
        )
          .sort()
          .join(", ")}.`,
      );
    }
    if (e.expectedHash !== undefined) {
      await assertUnchanged(section, file, e.expectedHash);
    }
    changes.push({ path: `${dir}/${file}`, content: e.newContent });
  }

  const firstLine = (summary || "template change").split("\n")[0].trim();
  const short = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;

  try {
    const res = await atomicCommit(changes, `dashboard: template edit — ${short}`, DASHBOARD_REPO);
    return { commitUrl: res.url };
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 409 || status === 422) {
      throw new TemplateError(
        "The template changed while you were reviewing. Ask for the change again to pick up the latest version.",
        409,
      );
    }
    console.error("loop-template: apply failed", err);
    throw new TemplateError("Couldn't save to GitHub. Try again.", 502);
  }
}

/**
 * Throw a 409 unless the stored file still hashes to `expectedHash`. A file
 * that has been deleted since it was opened counts as changed.
 */
async function assertUnchanged(
  section: TemplateSection,
  file: string,
  expectedHash: string,
): Promise<void> {
  let current: string | null;
  try {
    current = await readTemplateFile(section, file);
  } catch (err) {
    console.error("loop-template: base-version read failed", err);
    throw new TemplateError(
      "Couldn't check whether this file changed while you were editing, so nothing was saved. Try again.",
      502,
    );
  }
  if (current === null || templateContentHash(current) !== expectedHash) {
    throw new TemplateError(STALE_EDIT_MESSAGE, 409);
  }
}

/* ------------------------------------------------------------------ */
/* Drift detection                                                     */
/* ------------------------------------------------------------------ */

export type DriftStatus =
  | "identical"
  | "repo-behind-or-diverged"
  | "missing-in-repo"
  | "extra-in-repo";

export type DriftEntry = {
  file: string;
  status: DriftStatus;
  /** Unified diff template → repo. Empty string when `status` is identical. */
  diff: string;
};

export type TemplateDrift = {
  project: string;
  /** True when every template workflow is byte-identical in the repo. */
  inSync: boolean;
  counts: Record<DriftStatus, number>;
  files: DriftEntry[];
  /** True when the template itself has no workflows to compare against. */
  templateEmpty: boolean;
};

/** Lines of `text`, with the trailing empty line of a final newline dropped. */
function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Beyond this the O(n·m) LCS gets expensive — fall back to a whole-file diff. */
const MAX_DIFF_LINES = 3000;

type Op = { kind: " " | "-" | "+"; line: string };

/** Classic LCS backtrack → a flat list of context/removed/added lines. */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "-", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ kind: "-", line: a[i] });
  for (; j < m; j++) ops.push({ kind: "+", line: b[j] });
  return ops;
}

/**
 * A unified diff (3 lines of context) from `before` to `after`. Deliberately
 * dependency-free — the dashboard ships no diff library and this is the only
 * caller. Returns "" when the two texts are identical.
 */
export function unifiedDiff(
  before: string,
  after: string,
  fromLabel = "template",
  toLabel = "repo",
): string {
  if (before === after) return "";
  const a = toLines(before);
  const b = toLines(after);
  const header = `--- ${fromLabel}\n+++ ${toLabel}\n`;

  if (a.length + b.length > MAX_DIFF_LINES) {
    return (
      header +
      `@@ -1,${a.length} +1,${b.length} @@\n` +
      "(file too large to diff line-by-line — it differs from the template)\n"
    );
  }

  const ops = diffOps(a, b);
  const CONTEXT = 3;
  // Which ops to keep: every change plus CONTEXT lines either side.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.kind === " ") return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) {
      keep[k] = true;
    }
  });

  const out: string[] = [];
  let aLine = 1;
  let bLine = 1;
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].kind !== "+") aLine++;
      if (ops[idx].kind !== "-") bLine++;
      idx++;
      continue;
    }
    const hunkAStart = aLine;
    const hunkBStart = bLine;
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx];
      body.push(`${op.kind}${op.line}`);
      if (op.kind !== "+") {
        aLine++;
        aCount++;
      }
      if (op.kind !== "-") {
        bLine++;
        bCount++;
      }
      idx++;
    }
    // Unified-diff convention: an empty side is written as `<start-1>,0`.
    const aStart = aCount === 0 ? Math.max(0, hunkAStart - 1) : hunkAStart;
    const bStart = bCount === 0 ? Math.max(0, hunkBStart - 1) : hunkBStart;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    out.push(...body);
  }
  return header + out.join("\n") + "\n";
}

/**
 * Compare the template's workflows against one project's live
 * .github/workflows/ on main. Read-only — it never writes anything.
 *
 * `repo-behind-or-diverged` is deliberately one status: a byte comparison
 * can't tell "the repo missed a template update" from "someone edited the
 * repo's copy", and the fix (review the diff) is the same either way.
 *
 * Throws if the repo side can't be read. It used to swallow every error and
 * carry on with an empty map, so a 403 rate-limit or a five-second GitHub blip
 * reported every single template file as "missing in repo" — the drift chip
 * cried wolf about a project that was perfectly in sync. Only a genuine 404
 * (no `.github/workflows/` at all) still means "everything missing".
 */
export async function computeTemplateDrift(
  projectKey: string,
  repo: RepoConfig,
): Promise<TemplateDrift> {
  const [template, live] = await Promise.all([
    listTemplateWorkflows(),
    snapshotWorkflows("main", repo).catch((err: unknown) => {
      if ((err as { status?: number })?.status === 404) {
        // The repo genuinely has no .github/workflows/ — everything is missing.
        return new Map<string, string>();
      }
      throw err;
    }),
  ]);

  const names = [...new Set([...template.keys(), ...live.keys()])].sort();
  const files: DriftEntry[] = names.map((file) => {
    const t = template.get(file);
    const r = live.get(file);
    if (t === undefined) {
      return {
        file,
        status: "extra-in-repo" as const,
        diff: unifiedDiff("", r ?? "", `template/${file} (absent)`, `repo/${file}`),
      };
    }
    if (r === undefined) {
      return {
        file,
        status: "missing-in-repo" as const,
        diff: unifiedDiff(t, "", `template/${file}`, `repo/${file} (absent)`),
      };
    }
    if (t === r) return { file, status: "identical" as const, diff: "" };
    return {
      file,
      status: "repo-behind-or-diverged" as const,
      diff: unifiedDiff(t, r, `template/${file}`, `repo/${file}`),
    };
  });

  const counts: Record<DriftStatus, number> = {
    identical: 0,
    "repo-behind-or-diverged": 0,
    "missing-in-repo": 0,
    "extra-in-repo": 0,
  };
  for (const f of files) counts[f.status]++;

  return {
    project: projectKey,
    inSync: counts["repo-behind-or-diverged"] === 0 && counts["missing-in-repo"] === 0,
    counts,
    files,
    templateEmpty: template.size === 0,
  };
}
