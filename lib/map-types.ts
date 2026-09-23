/**
 * Shared types for the Process Map section. Kept framework-free so both server
 * (API routes) and client (React Flow nodes, drawer) can import them.
 */

/** Where a workflow's Claude prompt lives, if anywhere. */
export type DispatchKind = "none" | "issue" | "pr";

/** Static, hand-written description of one loop workflow. */
export type AgentMeta = {
  id: string;
  /** Plain-English name shown on the node and drawer. */
  label: string;
  /** Workflow filename in .github/workflows. */
  file: string;
  /** Short tagline shown under the node title. */
  tagline: string;
  /** Plain-English paragraph(s) of what this agent does. */
  description: string;
  /** Plain-English list of when it runs. */
  triggers: string[];
  /**
   * True if the workflow lives on the target repo's main branch. When false,
   * the agent isn't installed on this project yet, so editing and "Run now" are
   * disabled with a plain-English note.
   */
  onMain: boolean;
  /** True if the workflow declares workflow_dispatch (a "Run now" is possible). */
  canDispatch: boolean;
  /** Shape of the input the manual run needs, when it needs one. */
  dispatch: DispatchKind;
  /** True for non-baseline (custom, per-project) agents built at runtime. */
  generic?: boolean;
  /**
   * True when the workflow runs a Claude agent whose model the owner can pick
   * from the Model tab. Its template workflow reads the pick from
   * `.github/loop-config.json` -> `models.<id>` (see lib/loop-models.ts).
   */
  modelPicker?: boolean;
  /** Label + help text for the dispatch input, when dispatch !== "none". */
  dispatchInputLabel?: string;
  dispatchInputHelp?: string;
};

/** One historical workflow run, trimmed for the drawer. */
export type RunSummary = {
  id: number;
  status: string | null;
  conclusion: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Duration in seconds, when computable. */
  durationSec: number | null;
  url: string;
};

/** Live status of one agent node, for the map badges. */
export type AgentStatus = {
  id: string;
  file: string;
  /** Display name (baseline label, or the YAML `name:` for custom agents). */
  label: string;
  tagline: string;
  /** True for non-baseline claude-*.yml workflows found in the repo. */
  generic: boolean;
  /** False when the workflow is switched off on GitHub (disabled). */
  enabled: boolean;
  status: string | null; // queued | in_progress | completed | null (never run)
  conclusion: string | null; // success | failure | cancelled | ...
  createdAt: string | null;
  url: string | null;
};

/** Everything the map needs to render its live badges. */
export type MapStatus = {
  proposals: number;
  approved: number;
  openPRs: number;
  agents: AgentStatus[];
  /** Which project this status is for (registry key). */
  project: string;
  /** True when every loop workflow except @mention is switched off. */
  loopPaused: boolean;
  /** True when an AI drafting backend is available. */
  aiEnabled: boolean;
  /** Non-fatal warning (e.g. a partial failure) to surface in the UI. */
  warning?: string;
};

/** One commit in a history list. */
export type HistoryCommit = {
  sha: string;
  message: string;
  date: string | null;
  url: string;
};

/** A proposed change to one workflow file (AI draft or restore preview). */
export type FileChange = {
  /** Filename only, e.g. "claude-scout.yml". */
  file: string;
  oldContent: string | null;
  newContent: string;
  /**
   * True when this change REMOVES the file (template edits only — project
   * edits never delete). `newContent` is empty in that case.
   */
  delete?: boolean;
};

/** Capability chips parsed from a workflow's YAML + .mcp.json. */
export type Capabilities = {
  tools: string[];
  mcpServers: string[];
  skills: string[];
};

/** Full payload for the agent drawer. */
export type AgentDetail = {
  meta: AgentMeta;
  runs: RunSummary[];
  capabilities: Capabilities;
  /** The workflow ref the YAML was read from ("main" or the PR branch). */
  ref: string;
  /** True when the file was found. */
  fileFound: boolean;
  /** Friendly prompt text, when extractable. */
  prompt: string | null;
  /** Raw YAML of the workflow file. */
  rawYaml: string | null;
  /** True when the friendly prompt extractor succeeded. */
  promptExtractable: boolean;
  /** Reason extraction failed, when it did. */
  extractionNote?: string;
  /** True when instructions can be saved (file on main). */
  editable: boolean;
  /** GitHub link to the file's commit history. */
  historyUrl: string;
  /** True when an Anthropic API key is configured (AI drafting available). */
  aiEnabled: boolean;
  /**
   * Whether the repo has `.github/loop-models.json`, the list a workflow checks
   * a model pick against - without it every pick is ignored. Unset when it
   * wasn't checked (not a model-picker agent, or the read failed).
   */
  modelsListInstalled?: boolean;
};
