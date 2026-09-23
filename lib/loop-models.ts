/**
 * Which Claude model each loop agent runs on.
 *
 * The owner picks a model per agent (or one for all agents) on the Process
 * Map's Model tab. The pick is stored in the target repo's
 * `.github/loop-config.json` under `models`, keyed by the Process Map agent id:
 *
 *     { "models": { "all": "sonnet", "builder": "opus" } }
 *
 * and each agent workflow resolves it in a "Resolve AI model" step before the
 * agent starts: its own key first, then `all`, then the built-in default.
 *
 * The list of models on offer lives in ONE file,
 * config/loop-template/files/loop-models.json. The dashboard imports it here,
 * and the same file is installed into every target repo as
 * `.github/loop-models.json`, where the workflows check a pick against it. A
 * pick that is missing from that list, or a repo with no list at all, is
 * ignored with a warning and the agent runs on the default - never a red run.
 *
 * Framework-free and client-safe: the drawer imports it directly.
 */

import catalog from "@/config/loop-template/files/loop-models.json";
import { AGENTS } from "./map-agents";

export type ModelChoice = { id: string; label: string; blurb: string };

/** Every model the picker offers, in display order. */
export const MODEL_CHOICES: readonly ModelChoice[] = catalog.choices;

/**
 * The model an agent runs on when nothing is picked. It is also the literal
 * each workflow falls back to, pinned to this value by
 * tests/lib/loop-models.test.ts.
 */
export const DEFAULT_AGENT_MODEL: string = catalog.default;

/**
 * The key that sets every agent at once - the same "all" the Tools section's
 * install form uses for "All agents" (TARGET_AGENTS in lib/tools.ts).
 */
export const ALL_AGENTS_KEY = "all";

/** The Process Map agents whose workflow reads a model pick. */
export const MODEL_AGENT_IDS: readonly string[] = AGENTS.filter((a) => a.modelPicker).map(
  (a) => a.id,
);

/** Every key `models` may carry: one per agent, plus {@link ALL_AGENTS_KEY}. */
export const MODEL_KEYS: readonly string[] = [ALL_AGENTS_KEY, ...MODEL_AGENT_IDS];

/** Where the catalog installs inside a target repo. */
export const LOOP_MODELS_PATH = ".github/loop-models.json";

/**
 * True when a workflow takes its model from the "Resolve AI model" step (the
 * `--model ${{ steps.model.outputs.model ... }}` form every template agent
 * workflow uses), rather than naming one outright. A project whose workflows
 * predate the picker names one outright, and a pick does nothing there.
 */
export function workflowReadsModelPick(yaml: string | null | undefined): boolean {
  return /--model\s+\$\{\{\s*steps\.model\.outputs\.model\b/.test(yaml ?? "");
}

/** The picks as stored: model id by agent key. Every key optional. */
export type AgentModels = Record<string, string>;

export function isModelChoice(id: unknown): id is string {
  return typeof id === "string" && MODEL_CHOICES.some((c) => c.id === id);
}

export function modelLabel(id: string): string {
  return MODEL_CHOICES.find((c) => c.id === id)?.label ?? id;
}

/** Where an agent's effective model came from. */
export type ModelSource = "agent" | "all" | "default";

export type ResolvedModel = {
  model: string;
  source: ModelSource;
  /**
   * Picks the workflow will skip because they are not on the list - shown to
   * the owner so a hand-edited typo does not look like it applies.
   */
  ignored: { key: string; value: string }[];
};

/**
 * The model an agent's workflow will actually run on. Mirrors the workflows'
 * "Resolve AI model" step exactly: the agent's own pick, then the all-agents
 * pick, each used only when it is on the list, else the default.
 */
export function resolveAgentModel(
  models: AgentModels | undefined,
  agentId: string,
): ResolvedModel {
  const ignored: ResolvedModel["ignored"] = [];
  for (const [key, source] of [
    [agentId, "agent"],
    [ALL_AGENTS_KEY, "all"],
  ] as const) {
    const value = models?.[key];
    if (typeof value !== "string" || value === "") continue;
    if (isModelChoice(value)) return { model: value, source, ignored };
    ignored.push({ key, value });
  }
  return { model: DEFAULT_AGENT_MODEL, source: "default", ignored };
}
