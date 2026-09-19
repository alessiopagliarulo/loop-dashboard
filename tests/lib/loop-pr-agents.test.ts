/**
 * Which pull requests wake the loop's PR agents (the Auditor and Demo).
 *
 * Only loop PRs do: a `claude/` branch in the repo itself, opened by the loop's own
 * identity. The owner's hand-made PRs, including ones from their own Claude Code
 * sessions that also name a branch `claude/...`, get the plain CI checks and no agent,
 * because every agent run spends the owner's Claude subscription.
 *
 * The job `if:` is evaluated here with a small interpreter for the slice of GitHub's
 * expression syntax it uses, so these cases exercise the real guard, not a copy of it.
 * The author half is pinned to LOOP_AUTHOR_PATTERNS in loop-inflight.mjs, the one
 * definition of "the loop's own identity" the in-flight detection also uses.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import { LOOP_AUTHOR_PATTERNS, isLoopAuthor } from "../../config/loop-template/files/loop-inflight.mjs";

const WORKFLOWS_DIR = join(__dirname, "..", "..", "config/loop-template/workflows");
const PR_AGENTS = ["claude-audit.yml", "claude-demo.yml"];
const PR_TRIGGERS = ["pull_request", "pull_request_target", "push"];

type Job = { if?: string; steps?: unknown[] };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

function load(file: string): Workflow {
  const doc = yaml.load(readFileSync(join(WORKFLOWS_DIR, file), "utf8")) as Record<string, unknown>;
  // js-yaml reads a bare `on:` key as the boolean true.
  return { on: (doc.on ?? doc.true) as Record<string, unknown>, jobs: doc.jobs as Record<string, Job> };
}

/* ------------------------------------------------------------------ */
/* A minimal GitHub Actions expression evaluator                      */
/* ------------------------------------------------------------------ */

type Value = string | boolean | null | undefined;

/**
 * Supports what the guards use: string literals, dotted context paths, `==`, `!=`, `!`,
 * `&&`, `||`, parentheses, and `startsWith` / `contains` (both case-insensitive, as on
 * GitHub). Anything else throws, so a guard that outgrows this fails loudly here.
 */
function evaluate(expr: string, ctx: Record<string, unknown>): Value {
  const tokens = expr.match(/'(?:[^']|'')*'|&&|\|\||==|!=|[()!,]|[A-Za-z_][\w.-]*/g) ?? [];
  if (tokens.join("").replace(/\s/g, "") !== expr.replace(/\s/g, "")) throw new Error(`unsupported expression: ${expr}`);
  let i = 0;
  const peek = () => tokens[i];
  const take = (t?: string) => {
    if (t && tokens[i] !== t) throw new Error(`expected ${t} at ${tokens[i]}`);
    return tokens[i++];
  };
  const truthy = (v: Value) => v !== "" && v !== false && v != null;
  const lower = (v: Value) => String(v ?? "").toLowerCase();

  const primary = (): Value => {
    const t = take();
    if (t === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (t === "!") return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (peek() === "(") {
      take("(");
      const args: Value[] = [or()];
      while (peek() === ",") {
        take(",");
        args.push(or());
      }
      take(")");
      if (t === "startsWith") return lower(args[0]).startsWith(lower(args[1]));
      if (t === "contains") return lower(args[0]).includes(lower(args[1]));
      throw new Error(`unsupported function ${t}`);
    }
    return t.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], ctx) as Value;
  };
  const cmp = (): Value => {
    let v = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = take();
      const r = primary();
      v = op === "==" ? lower(v) === lower(r) : lower(v) !== lower(r);
    }
    return v;
  };
  const and = (): Value => {
    let v = cmp();
    while (peek() === "&&") {
      take();
      const r = cmp();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const or = (): Value => {
    let v = and();
    while (peek() === "||") {
      take();
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  const v = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in ${expr}`);
  return v;
}

/* ------------------------------------------------------------------ */
/* The cases                                                           */
/* ------------------------------------------------------------------ */

const REPO = "acme/shop";

function prEvent(headRef: string, author: string, headRepo = REPO) {
  return {
    github: {
      event_name: "pull_request",
      repository: REPO,
      event: { pull_request: { head: { ref: headRef, repo: { full_name: headRepo } }, user: { login: author } } },
    },
  };
}

const runs = (file: string, ctx: Record<string, unknown>) => {
  const jobs = Object.values(load(file).jobs);
  return jobs.some((j) => j.if === undefined || evaluate(j.if, ctx) === true);
};

describe("the loop's PR agents run on loop PRs only", () => {
  for (const file of PR_AGENTS) {
    describe(file, () => {
      it("runs on a loop PR: a claude/ branch the Builder opened", () => {
        expect(runs(file, prEvent("claude/issue-12-csv-export", "claude[bot]"))).toBe(true);
        expect(runs(file, prEvent("claude/issue-12-csv-export", "github-actions[bot]"))).toBe(true);
      });

      it("is skipped on a firstmate fm/ branch", () => {
        expect(runs(file, prEvent("fm/ld-loop-pr-only", "alessiopagliarulo"))).toBe(false);
        expect(runs(file, prEvent("fm/ld-loop-pr-only", "claude[bot]"))).toBe(false);
      });

      it("is skipped on the owner's own branch", () => {
        expect(runs(file, prEvent("fix-typo", "alessiopagliarulo"))).toBe(false);
        expect(runs(file, prEvent("main-hotfix", "alessiopagliarulo"))).toBe(false);
      });

      it("is skipped on a claude/ branch the owner opened (their own Claude Code session)", () => {
        expect(runs(file, prEvent("claude/tidy-readme-x7Qp2", "alessiopagliarulo"))).toBe(false);
      });

      it("is skipped on a claude/ branch from a fork, even one opened by a bot", () => {
        expect(runs(file, prEvent("claude/issue-1", "claude[bot]", "stranger/shop"))).toBe(false);
      });

      it("still runs on a manual workflow_dispatch, which is the owner asking", () => {
        expect(runs(file, { github: { event_name: "workflow_dispatch", repository: REPO, event: {} } })).toBe(true);
      });

      it("guards every job, so no other trigger path reaches an agent either", () => {
        for (const [name, job] of Object.entries(load(file).jobs)) expect(job.if, `${file} ${name}`).toBeTruthy();
      });
    });
  }

  it("agrees with the in-flight detector's definition of the loop's identity", () => {
    const logins = [
      ...LOOP_AUTHOR_PATTERNS.map((p) => `x-${p}-x`),
      "claude[bot]",
      "github-actions[bot]",
      "dependabot[bot]",
      "anthropic-bot",
      "alessiopagliarulo",
      "octocat",
    ];
    for (const file of PR_AGENTS) {
      for (const login of logins) {
        expect(runs(file, prEvent("claude/x", login)), `${file} ${login}`).toBe(isLoopAuthor(login));
      }
    }
  });

  it("every Claude workflow with a PR or push trigger is one of the guarded agents", () => {
    const triggered = readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.startsWith("claude-") && f.endsWith(".yml"))
      .filter((f) => PR_TRIGGERS.some((t) => t in (load(f).on ?? {})))
      .sort();
    expect(triggered).toEqual([...PR_AGENTS].sort());
  });

  it("leaves the plain CI checks on every PR", () => {
    expect("pull_request" in load("repo-tests.yml").on).toBe(true);
    expect(runs("repo-tests.yml", prEvent("fm/ld-loop-pr-only", "alessiopagliarulo"))).toBe(true);
    expect(runs("repo-tests.yml", prEvent("fix-typo", "alessiopagliarulo"))).toBe(true);
    expect(runs("repo-tests.yml", prEvent("claude/issue-12-csv-export", "claude[bot]"))).toBe(true);
    expect(runs("repo-tests.yml", prEvent("claude/issue-1", "claude[bot]", "stranger/shop"))).toBe(true);
  });
});
