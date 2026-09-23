/**
 * Which Claude model each loop agent runs on.
 *
 * The owner picks a model per agent on the Process Map's Model tab. The pick is
 * stored in the target repo's `.github/loop-config.json` under `models`, keyed
 * by the Process Map agent id:
 *
 *     { "models": { "builder": "sonnet", "audit": "haiku" } }
 *
 * and each agent workflow resolves it in a "Resolve AI model" step before the
 * agent starts: its own key, else the built-in default.
 *
 * The models on offer are listed here and, as an inline `case`, in each
 * workflow's resolve step (the same way the `aiProvider` step checks its
 * value), so a repo needs no extra file and a workflow updated from the loop
 * template honours picks straight away. tests/lib/loop-models.test.ts runs
 * every workflow's step against every id below so the two cannot drift. A pick
 * that isn't on the list is ignored with a warning and the agent runs on the
 * default - never a red run.
 *
 * Framework-free and client-safe: the drawer imports it directly.
 */

import { AGENTS } from "./map-agents";

export type ModelChoice = { id: string; label: string; blurb: string };

/** Every model the picker offers, in display order. */
export const MODEL_CHOICES: readonly ModelChoice[] = [
  {
    id: "opus",
    label: "Opus",
    blurb:
      "The most capable model, and what every agent ran on before this setting existed. Uses the most of your plan's usage limits.",
  },
  {
    id: "sonnet",
    label: "Sonnet",
    blurb:
      "Fast and strong. A good fit for most coding and review work, and lighter on your usage limits.",
  },
  {
    id: "haiku",
    label: "Haiku",
    blurb:
      "The fastest and lightest. Best for simple, well-defined jobs; noticeably weaker on hard problems.",
  },
];

/**
 * The model an agent runs on when nothing is picked: what every agent ran on
 * before the picker existed, and the fallback each workflow uses.
 */
export const DEFAULT_AGENT_MODEL = "opus";

/** The Process Map agents whose workflow reads a model pick. */
export const MODEL_AGENT_IDS: readonly string[] = AGENTS.filter((a) => a.modelPicker).map(
  (a) => a.id,
);

/**
 * True when a workflow takes its model from the "Resolve AI model" step (the
 * `--model ${{ steps.model.outputs.model ... }}` form every template agent
 * workflow uses), rather than naming one outright. A project whose workflows
 * predate the picker names one outright, and a pick does nothing there until
 * the workflow is updated from the loop template.
 */
export function workflowReadsModelPick(yaml: string | null | undefined): boolean {
  return /--model\s+\$\{\{\s*steps\.model\.outputs\.model\b/.test(yaml ?? "");
}

/**
 * The model a workflow that predates the picker names outright
 * (`--model opus`), or null when it names none.
 */
export function modelNamedByWorkflow(yaml: string | null | undefined): string | null {
  return (yaml ?? "").match(/--model\s+([A-Za-z0-9._-]+)/)?.[1] ?? null;
}

/** The picks as stored: model id by agent key. Every key optional. */
export type AgentModels = Record<string, string>;

export function isModelChoice(id: unknown): id is string {
  return typeof id === "string" && MODEL_CHOICES.some((c) => c.id === id);
}

export function modelLabel(id: string): string {
  return MODEL_CHOICES.find((c) => c.id === id)?.label ?? id;
}

export type ResolvedModel = {
  model: string;
  /** "agent" when the pick is used, "default" otherwise. */
  source: "agent" | "default";
  /**
   * True when the agent has a pick the workflow will skip because it is not on
   * the list - shown to the owner so a hand-edited typo does not look like it
   * applies.
   */
  ignored: string | null;
};

/**
 * The model an agent's workflow will actually run on. Mirrors the workflows'
 * "Resolve AI model" step: the agent's own pick when it is on the list, else
 * the default.
 */
export function resolveAgentModel(
  models: AgentModels | undefined,
  agentId: string,
): ResolvedModel {
  const value = models?.[agentId];
  if (typeof value === "string" && value !== "") {
    if (isModelChoice(value)) return { model: value, source: "agent", ignored: null };
    return { model: DEFAULT_AGENT_MODEL, source: "default", ignored: value };
  }
  return { model: DEFAULT_AGENT_MODEL, source: "default", ignored: null };
}
