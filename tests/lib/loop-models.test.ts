/**
 * The per-agent model picker, end to end without a live run.
 *
 * Three things have to agree for a pick on the Process Map to change what an
 * agent runs on: the dashboard writes `models.<agent>` into
 * `.github/loop-config.json`, the target repo holds the list of allowed models
 * (`.github/loop-models.json`, installed from the same file the dashboard
 * imports), and each agent workflow's "Resolve AI model" step turns the two
 * into `--model`. These tests pin all three together, and run the workflow step
 * itself against fixture repos so "never a red run" is exercised, not assumed.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/github", () => ({
  getFileWithSha: vi.fn(),
  commitFile: vi.fn(),
  getFileContent: vi.fn(),
  getOctokit: vi.fn(),
  listWorkflowFiles: vi.fn(),
}));

import { commitFile, getFileWithSha } from "../../lib/github";
import {
  LoopConfigError,
  normalizeLoopConfig,
  serializeLoopConfig,
  setLoopConfig,
} from "../../lib/loop-config";
import {
  ALL_AGENTS_KEY,
  DEFAULT_AGENT_MODEL,
  LOOP_MODELS_PATH,
  MODEL_AGENT_IDS,
  MODEL_CHOICES,
  MODEL_KEYS,
  resolveAgentModel,
  workflowReadsModelPick,
} from "../../lib/loop-models";
import { TEMPLATE_FILE_TARGETS } from "../../lib/loop-template";
import { AGENTS } from "../../lib/map-agents";
import { TARGET_AGENTS } from "../../lib/tools";

const ROOT = join(__dirname, "..", "..");
const WORKFLOWS_DIR = join(ROOT, "config/loop-template/workflows");
const CATALOG = readFileSync(join(ROOT, "config/loop-template/files/loop-models.json"), "utf8");

type Step = { name?: string; id?: string; uses?: string; env?: Record<string, string>; run?: string; with?: Record<string, string> };
type Job = { steps?: Step[] };

function jobsOf(file: string): Record<string, Job> {
  return (yaml.load(readFileSync(join(WORKFLOWS_DIR, file), "utf8")) as { jobs: Record<string, Job> }).jobs;
}

/** The job that holds the agent's "Resolve AI model" step. */
function modelJob(file: string): Job {
  const job = Object.values(jobsOf(file)).find((j) => j.steps?.some((s) => s.id === "model"));
  if (!job) throw new Error(`${file} has no Resolve AI model step`);
  return job;
}

function modelStep(file: string): Step {
  return modelJob(file).steps!.find((s) => s.id === "model")!;
}

const pickerAgents = AGENTS.filter((a) => a.modelPicker);

/* ------------------------------------------------------------------ */
/* One list, everywhere                                                */
/* ------------------------------------------------------------------ */

describe("the list of models", () => {
  it("offers the default, with unique ids safe to put on a command line", () => {
    const ids = MODEL_CHOICES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_AGENT_MODEL);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    for (const c of MODEL_CHOICES) {
      expect(c.label.trim()).not.toBe("");
      expect(c.blurb.trim()).not.toBe("");
    }
  });

  it("is installed into every new project where the workflows read it", () => {
    expect(TEMPLATE_FILE_TARGETS["loop-models.json"]).toBe(LOOP_MODELS_PATH);
    for (const a of pickerAgents) expect(modelStep(a.file).run).toContain(LOOP_MODELS_PATH);
  });

  it("appears in no workflow: they check a pick against the installed file instead", () => {
    for (const a of pickerAgents) {
      const run = modelStep(a.file).run!;
      for (const c of MODEL_CHOICES.filter((c) => c.id !== DEFAULT_AGENT_MODEL)) {
        expect(run).not.toMatch(new RegExp(`\\b${c.id}\\b`));
      }
    }
  });
});

describe("the agents a model can be picked for", () => {
  it("are the Process Map's Claude agents, keyed by their map id, plus the Tools section's 'all'", () => {
    expect(MODEL_KEYS).toEqual([ALL_AGENTS_KEY, ...MODEL_AGENT_IDS]);
    expect(TARGET_AGENTS.map((t) => t.value)).toContain(ALL_AGENTS_KEY);
    for (const t of TARGET_AGENTS) expect(MODEL_KEYS).toContain(t.value);
  });

  it("covers every template workflow that runs Claude, and only those", () => {
    const runsClaude = readdirSync(WORKFLOWS_DIR).filter((f) =>
      readFileSync(join(WORKFLOWS_DIR, f), "utf8").includes("anthropics/claude-code-action"),
    );
    expect(pickerAgents.map((a) => a.file).sort()).toEqual(runsClaude.sort());
    expect(AGENTS.find((a) => a.id === "metrics")?.modelPicker).toBeFalsy();
  });

  it.each(pickerAgents.map((a) => [a.file, a.id]))("%s resolves its own key (%s)", (file, id) => {
    expect(modelStep(file).env?.AGENT).toBe(id);
  });
});

/* ------------------------------------------------------------------ */
/* The workflows use the pick                                          */
/* ------------------------------------------------------------------ */

describe("each agent workflow", () => {
  it.each(pickerAgents.map((a) => [a.file]))("%s passes the resolved model to every agent step", (file) => {
    const steps = modelJob(file).steps!;
    const at = steps.findIndex((s) => s.id === "model");
    const agentSteps = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.uses?.startsWith("anthropics/claude-code-action"));
    expect(agentSteps.length).toBeGreaterThan(0);
    for (const { s, i } of agentSteps) {
      // After the step it reads, never conditional on it (the step has no `if:`).
      expect(i).toBeGreaterThan(at);
      expect(s.with?.claude_args).toContain(
        `--model \${{ steps.model.outputs.model || '${DEFAULT_AGENT_MODEL}' }}`,
      );
    }
    expect(steps[at]).not.toHaveProperty("if");
    expect(workflowReadsModelPick(readFileSync(join(WORKFLOWS_DIR, file), "utf8"))).toBe(true);
  });

  it.each(pickerAgents.map((a) => [a.file]))("%s falls back to the default the list names", (file) => {
    expect(modelStep(file).run).toMatch(new RegExp(`^model=${DEFAULT_AGENT_MODEL}$`, "m"));
  });

  it("the resolve step is the same script in every workflow", () => {
    const scripts = new Set(pickerAgents.map((a) => modelStep(a.file).run));
    expect(scripts.size).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Running the step: never red, and the same answer as the dashboard   */
/* ------------------------------------------------------------------ */

/**
 * Runs the "Resolve AI model" step the way Actions does (`bash -e`) in a repo
 * holding `config` as .github/loop-config.json and `catalog` as
 * .github/loop-models.json (`null` = no such file).
 */
function runModelStep(file: string, config: string | null, catalog: string | null = CATALOG) {
  const step = modelStep(file);
  const dir = mkdtempSync(join(tmpdir(), "loop-model-"));
  mkdirSync(join(dir, ".github"));
  if (config !== null) writeFileSync(join(dir, ".github/loop-config.json"), config);
  if (catalog !== null) writeFileSync(join(dir, LOOP_MODELS_PATH), catalog);
  const outputs = join(dir, "github-output");
  writeFileSync(outputs, "");
  const res = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run!], {
    cwd: dir,
    encoding: "utf8",
    env: { ...step.env, PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: outputs } as unknown as NodeJS.ProcessEnv,
  });
  return { status: res.status, stdout: res.stdout, outputs: readFileSync(outputs, "utf8") };
}

const cfg = (models: unknown) => JSON.stringify({ prCap: 3, models });

const SCENARIOS: { name: string; config: string | null; catalog?: string | null; builder: string; warns: boolean }[] = [
  { name: "no loop-config.json", config: null, builder: "opus", warns: false },
  { name: "a config with no models key", config: JSON.stringify({ prCap: 3 }), builder: "opus", warns: false },
  { name: "a config that is not JSON", config: "{ nope", builder: "opus", warns: false },
  { name: "models that is not an object", config: cfg("sonnet"), builder: "opus", warns: false },
  { name: "models that is an array", config: cfg(["sonnet"]), builder: "opus", warns: false },
  { name: "a pick for this agent", config: cfg({ builder: "sonnet" }), builder: "sonnet", warns: false },
  { name: "a pick for all agents", config: cfg({ all: "haiku" }), builder: "haiku", warns: false },
  { name: "this agent's pick over all", config: cfg({ all: "haiku", builder: "sonnet" }), builder: "sonnet", warns: false },
  { name: "another agent's pick", config: cfg({ audit: "haiku" }), builder: "opus", warns: false },
  { name: "a non-string pick", config: cfg({ builder: 7 }), builder: "opus", warns: false },
  { name: "an empty pick", config: cfg({ builder: "" }), builder: "opus", warns: false },
  { name: "a model not on the list", config: cfg({ builder: "gpt-5" }), builder: "opus", warns: true },
  { name: "an unlisted pick, then a good all", config: cfg({ builder: "gpt-5", all: "sonnet" }), builder: "sonnet", warns: true },
  { name: "an extra flag smuggled in", config: cfg({ builder: "opus --dangerously-skip-permissions" }), builder: "opus", warns: true },
  { name: "a newline smuggled in", config: cfg({ builder: "sonnet\nmodel=haiku" }), builder: "opus", warns: true },
  { name: "no list of models in the repo", config: cfg({ builder: "sonnet" }), catalog: null, builder: "opus", warns: true },
  { name: "a list that is not JSON", config: cfg({ builder: "sonnet" }), catalog: "[oops", builder: "opus", warns: true },
  { name: "a list of the wrong shape", config: cfg({ builder: "sonnet" }), catalog: JSON.stringify(["sonnet"]), builder: "opus", warns: true },
];

describe("the Resolve AI model step", () => {
  it.each(SCENARIOS.map((s) => [s.name, s]))("with %s it exits 0 and picks the right model", (_n, s) => {
    const res = runModelStep("claude-builder.yml", s.config, s.catalog === undefined ? CATALOG : s.catalog);
    expect(res.status).toBe(0);
    // Exactly one output line, so nothing smuggled in a value can add another.
    expect(res.outputs).toBe(`model=${s.builder}\n`);
    expect(res.stdout.includes("::warning::")).toBe(s.warns);
  });

  it("gives the same answer the dashboard shows, when the list is installed", () => {
    for (const s of SCENARIOS.filter((s) => s.catalog === undefined)) {
      let parsed: unknown = null;
      try {
        parsed = s.config === null ? null : JSON.parse(s.config);
      } catch {
        parsed = null;
      }
      const shown = resolveAgentModel(normalizeLoopConfig(parsed).models, "builder").model;
      expect(shown, s.name).toBe(s.builder);
    }
  });

  it.each(pickerAgents.map((a) => [a.file, a.id]))("in %s honours a pick for %s", (file, id) => {
    const res = runModelStep(file, cfg({ [id]: "haiku", all: "sonnet" }));
    expect(res.status).toBe(0);
    expect(res.outputs).toBe("model=haiku\n");
  });
});

/* ------------------------------------------------------------------ */
/* The dashboard side of loop-config.json                              */
/* ------------------------------------------------------------------ */

describe("models in loop-config.json", () => {
  it("never appears in a file where nothing was picked", () => {
    expect(JSON.parse(serializeLoopConfig(normalizeLoopConfig({ prCap: 3 })))).not.toHaveProperty("models");
    expect(JSON.parse(serializeLoopConfig(normalizeLoopConfig({ models: {} })))).not.toHaveProperty("models");
  });

  it("keeps picks it doesn't recognise, so an unrelated save never deletes one", () => {
    const raw = { models: { builder: "sonnet", futureagent: "opus", audit: "gpt-5", retro: 3 } };
    expect(JSON.parse(serializeLoopConfig(normalizeLoopConfig(raw))).models).toEqual({
      builder: "sonnet",
      futureagent: "opus",
      audit: "gpt-5",
    });
  });

  it("reads a models value that is not an object as nothing picked", () => {
    expect(normalizeLoopConfig({ models: "opus" }).models).toBeUndefined();
    expect(normalizeLoopConfig({ models: ["opus"] }).models).toBeUndefined();
  });
});

describe("saving a pick", () => {
  let written: string | null;

  function stored(content: unknown) {
    vi.mocked(getFileWithSha).mockResolvedValue({ content: JSON.stringify(content), sha: "abc" } as never);
  }

  beforeEach(() => {
    written = null;
    vi.mocked(commitFile).mockReset();
    vi.mocked(commitFile).mockImplementation((async (_path: string, content: string) => {
      written = content;
    }) as never);
  });

  const repo = { owner: "o", repo: "r" };

  it("sets one key and leaves every other setting alone", async () => {
    stored({ version: 1, prCap: 5, aiProvider: "bedrock", models: { audit: "haiku" }, scout: { aiProvider: "subscription" } });
    await setLoopConfig(repo, { models: { builder: "sonnet" } });
    const saved = JSON.parse(written!);
    expect(saved.models).toEqual({ audit: "haiku", builder: "sonnet" });
    expect(saved).toMatchObject({ version: 1, prCap: 5, aiProvider: "bedrock" });
    expect(saved.scout.aiProvider).toBe("subscription");
  });

  it("clears a key with null, and drops the block once it is empty", async () => {
    stored({ models: { builder: "sonnet" } });
    await setLoopConfig(repo, { models: { builder: null } });
    expect(JSON.parse(written!)).not.toHaveProperty("models");
  });

  it("refuses a model that is not on the list, writing nothing", async () => {
    stored({});
    await expect(setLoopConfig(repo, { models: { builder: "gpt-5" } })).rejects.toBeInstanceOf(LoopConfigError);
    await expect(setLoopConfig(repo, { models: { builder: "opus --x" } })).rejects.toBeInstanceOf(LoopConfigError);
    expect(commitFile).not.toHaveBeenCalled();
  });

  it("refuses an agent that has no model to pick", async () => {
    stored({});
    await expect(setLoopConfig(repo, { models: { metrics: "opus" } })).rejects.toThrow(/models\.metrics/);
    await expect(setLoopConfig(repo, { models: "opus" } as never)).rejects.toBeInstanceOf(LoopConfigError);
    expect(commitFile).not.toHaveBeenCalled();
  });

  it("leaves the Scout's own aiProvider where the Scout workflow reads it", async () => {
    stored({ scout: { aiProvider: "bedrock", maxPerRun: 2 } });
    await setLoopConfig(repo, { models: { scout: "sonnet" } });
    const saved = JSON.parse(written!);
    expect(saved.scout.aiProvider).toBe("bedrock");
    expect(saved.scout).not.toHaveProperty("extra");
  });

  it("doesn't block an unrelated save on a pick someone hand-edited", async () => {
    stored({ models: { audit: "gpt-5" } });
    await setLoopConfig(repo, { prCap: 4 });
    expect(JSON.parse(written!).models).toEqual({ audit: "gpt-5" });
  });
});
