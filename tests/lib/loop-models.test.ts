/**
 * The per-agent model picker, end to end without a live run.
 *
 * Two things have to agree for a pick on the Process Map to change what an
 * agent runs on: the dashboard writes `models.<agent>` into
 * `.github/loop-config.json`, and each agent workflow's "Resolve AI model" step
 * turns that into `--model`. The step carries its own list of accepted models
 * (as the `aiProvider` step does), so these tests run the real step, for every
 * workflow, against every model the dashboard offers - that is what keeps the
 * two lists together - and against hostile and malformed configs so "never a
 * red run" is exercised, not assumed.
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
  DEFAULT_AGENT_MODEL,
  MODEL_AGENT_IDS,
  MODEL_CHOICES,
  modelNamedByWorkflow,
  resolveAgentModel,
  workflowReadsModelPick,
} from "../../lib/loop-models";
import { AGENTS } from "../../lib/map-agents";

const ROOT = join(__dirname, "..", "..");
const WORKFLOWS_DIR = join(ROOT, "config/loop-template/workflows");

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
});

describe("the agents a model can be picked for", () => {
  it("are the Process Map's Claude agents, keyed by their map id", () => {
    expect(MODEL_AGENT_IDS).toEqual(pickerAgents.map((a) => a.id));
    expect(MODEL_AGENT_IDS).not.toContain("metrics");
  });

  it("are exactly the template workflows that run the Claude agent action", () => {
    const runsClaude = readdirSync(WORKFLOWS_DIR).filter((f) =>
      Object.values(jobsOf(f)).some((j) =>
        j.steps?.some((s) => s.uses?.startsWith("anthropics/claude-code-action")),
      ),
    );
    expect(pickerAgents.map((a) => a.file).sort()).toEqual(runsClaude.sort());
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
});

/* ------------------------------------------------------------------ */
/* Running the step: never red, and the same answer as the dashboard   */
/* ------------------------------------------------------------------ */

/**
 * Runs the "Resolve AI model" step the way Actions does (`bash -e`) in a repo
 * holding `config` as .github/loop-config.json (`null` = no such file).
 */
function runModelStep(file: string, config: string | null) {
  const step = modelStep(file);
  const dir = mkdtempSync(join(tmpdir(), "loop-model-"));
  mkdirSync(join(dir, ".github"));
  if (config !== null) writeFileSync(join(dir, ".github/loop-config.json"), config);
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

const SCENARIOS: { name: string; config: string | null; builder: string; warns: boolean }[] = [
  { name: "no loop-config.json", config: null, builder: "opus", warns: false },
  { name: "a config with no models key", config: JSON.stringify({ prCap: 3 }), builder: "opus", warns: false },
  { name: "a config that is not JSON", config: "{ nope", builder: "opus", warns: false },
  { name: "models that is not an object", config: cfg("sonnet"), builder: "opus", warns: false },
  { name: "models that is an array", config: cfg(["sonnet"]), builder: "opus", warns: false },
  { name: "a pick for this agent", config: cfg({ builder: "sonnet" }), builder: "sonnet", warns: false },
  { name: "another agent's pick", config: cfg({ audit: "haiku" }), builder: "opus", warns: false },
  { name: "a key nothing reads", config: cfg({ all: "haiku" }), builder: "opus", warns: false },
  { name: "a non-string pick", config: cfg({ builder: 7 }), builder: "opus", warns: false },
  { name: "an empty pick", config: cfg({ builder: "" }), builder: "opus", warns: false },
  { name: "a model not on the list", config: cfg({ builder: "gpt-5" }), builder: "opus", warns: true },
  { name: "a differently cased model", config: cfg({ builder: "Sonnet" }), builder: "opus", warns: true },
  { name: "an extra flag smuggled in", config: cfg({ builder: "opus --dangerously-skip-permissions" }), builder: "opus", warns: true },
  { name: "a newline smuggled in", config: cfg({ builder: "sonnet\nmodel=haiku" }), builder: "opus", warns: true },
];

describe("the Resolve AI model step", () => {
  it.each(SCENARIOS.map((s) => [s.name, s]))("with %s it exits 0 and picks the right model", (_n, s) => {
    const res = runModelStep("claude-builder.yml", s.config);
    expect(res.status).toBe(0);
    // Exactly one output line, so nothing smuggled in a value can add another.
    expect(res.outputs).toBe(`model=${s.builder}\n`);
    expect(res.stdout.includes("::warning::")).toBe(s.warns);
  });

  it("gives the same answer the dashboard shows", () => {
    for (const s of SCENARIOS) {
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

  it.each(pickerAgents.flatMap((a) => MODEL_CHOICES.map((c) => [a.file, a.id, c.id])))(
    "in %s a pick for %s of %s is honoured",
    (file, id, model) => {
      const res = runModelStep(file, cfg({ [id]: model }));
      expect(res.status).toBe(0);
      expect(res.outputs).toBe(`model=${model}\n`);
      expect(res.stdout).not.toContain("::warning::");
    },
  );

  it.each(pickerAgents.map((a) => [a.file, a.id]))("in %s another agent's pick or a bad one leaves the default", (file, id) => {
    const other = pickerAgents.find((a) => a.id !== id)!.id;
    for (const config of [null, cfg({ [other]: "haiku" }), cfg({ [id]: "gpt-5" })]) {
      const res = runModelStep(file, config);
      expect(res.status).toBe(0);
      expect(res.outputs).toBe(`model=${DEFAULT_AGENT_MODEL}\n`);
    }
  });
});

describe("a workflow that predates the picker", () => {
  const old = "claude_args: |\n  --model opus\n  --max-turns 80\n";

  it("is told apart from one that reads the pick, and names its own model", () => {
    expect(workflowReadsModelPick(old)).toBe(false);
    expect(workflowReadsModelPick(null)).toBe(false);
    expect(modelNamedByWorkflow(old)).toBe("opus");
    expect(modelNamedByWorkflow("no model here")).toBeNull();
    for (const a of pickerAgents) {
      const yamlText = readFileSync(join(WORKFLOWS_DIR, a.file), "utf8");
      expect(workflowReadsModelPick(yamlText), a.file).toBe(true);
    }
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
