/**
 * Static description of the whole autonomous loop: the nine agent/CI workflows
 * and the flow of stages between them. This is the single source of truth for
 * both the map layout (fixed node positions) and the drawer content.
 *
 * Descriptions and triggers are written in plain English for a non-technical
 * owner. The live badges (run status, open counts) are layered on at runtime
 * from /api/map/status.
 */

import type { AgentMeta } from "./map-types";

/**
 * Legacy fallback branch. All workflows now live on main; this ref is only
 * consulted if a file unexpectedly disappears from main.
 */
export const FALLBACK_REF = "claude/dashboard-support-workflows";

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

export const AGENTS: AgentMeta[] = [
  {
    id: "scout",
    label: "Scout",
    file: "claude-scout.yml",
    tagline: "Finds work worth doing",
    description:
      "Every hour the Scout researches the market and your own codebase, then files new ideas as GitHub issues for you to look at. It never writes code — it only stocks the shelf of ideas. It keeps at most 8 open ideas so the queue stays useful, not noisy.",
    triggers: ["Automatically every hour", "Can be run on demand"],
    onMain: true,
    canDispatch: true,
    modelPicker: true,
    dispatch: "none",
  },
  {
    id: "redraft",
    label: "Redraft",
    file: "claude-redraft.yml",
    tagline: "Rewrites an idea you sent back",
    description:
      "When you send an idea back (by adding the 'redraft' label and leaving a comment on what to change), the Redraft agent rewrites that idea to match your feedback and puts it back in the ideas queue for another look.",
    triggers: [
      "When you add the 'redraft' label to an idea",
      "Can be run on demand for a specific idea",
    ],
    onMain: true,
    canDispatch: true,
    modelPicker: true,
    dispatch: "issue",
    dispatchInputLabel: "Idea number",
    dispatchInputHelp: "The number of the idea (GitHub issue) you want rewritten.",
  },
  {
    id: "builder",
    label: "Builder",
    file: "claude-builder.yml",
    tagline: "Turns an idea into a pull request",
    description:
      "The Builder picks the single strongest idea — anything you approved jumps the queue — and does the work, opening ONE pull request from a 'claude/' branch. It runs shortly after you approve something, with a safety-net schedule as backup.",
    triggers: [
      "When you approve an idea (the 'approved' label)",
      "Every 30 minutes as a backstop",
      "Can be run on demand",
    ],
    onMain: true,
    canDispatch: true,
    modelPicker: true,
    dispatch: "none",
  },
  {
    id: "audit",
    label: "Auditor",
    file: "claude-audit.yml",
    tagline: "Reviews the pull request hard",
    description:
      "For every pull request the Builder opens, the Auditor runs five tough, adversarial reviewers over it and posts a single verdict comment: SHIP, FIX FIRST, or DO NOT MERGE. It is the quality gate before you spend time looking.",
    triggers: ["Automatically on every pull request"],
    onMain: true,
    canDispatch: false,
    modelPicker: true,
    dispatch: "none",
  },
  {
    id: "demo",
    label: "Demo",
    file: "claude-demo.yml",
    tagline: "Captures proof it works",
    description:
      "The Demo agent actually runs the change and captures screenshots and video as evidence, uploads them to the pull request, and posts a '📸 Demo evidence' comment — so you can see it working before you merge, without running anything yourself.",
    triggers: [
      "Automatically on 'claude/' pull requests",
      "Can be run on demand for a specific pull request",
    ],
    onMain: true,
    canDispatch: true,
    modelPicker: true,
    dispatch: "pr",
    dispatchInputLabel: "Pull request number",
    dispatchInputHelp: "The number of the pull request to capture evidence for.",
  },
  {
    id: "retro",
    label: "Retro",
    file: "claude-retro.yml",
    tagline: "Learns from the week",
    description:
      "Once a week the Retro looks back at what got approved, ignored, or merged, and proposes edits to the loop's own lessons file and to the other agents' instructions — so the whole system gets a little better over time.",
    triggers: ["Automatically every Sunday evening", "Can be run on demand"],
    onMain: true,
    canDispatch: true,
    modelPicker: true,
    dispatch: "none",
  },
  {
    id: "metrics",
    label: "Metrics",
    file: "loop-metrics.yml",
    tagline: "Writes the daily summary",
    description:
      "A plain reporting job (no AI) that gathers the loop's numbers each morning and writes them up so you get a quick health read before you even look at your phone.",
    triggers: [
      "Automatically every morning",
      "On every pull request",
      "Can be run on demand",
    ],
    onMain: true,
    canDispatch: true,
    dispatch: "none",
  },
  {
    id: "mention",
    label: "@mention",
    file: "claude-mention.yml",
    tagline: "Your phone remote control",
    description:
      "Type '@claude' followed by anything in any issue or pull-request comment — right from the GitHub phone app — and an agent wakes up, does the work, and replies or opens a pull request. This is how you steer the loop on the go.",
    triggers: [
      "When you comment '@claude ...' on an issue or pull request",
      "When you open an issue mentioning '@claude'",
    ],
    onMain: true,
    canDispatch: false,
    modelPicker: true,
    dispatch: "none",
  },
  {
    id: "toolinstall",
    label: "Tool installer",
    file: "claude-tool-install.yml",
    tagline: "Gives agents new abilities",
    description:
      "When you ask for a new capability (a tool, skill, or connected service) from the Tools section, this agent wires it into the right workflow so the loop's agents can use it. It's triggered behind the scenes by the Tools section.",
    triggers: ["Triggered from the Tools section (a 'tool-install' event)"],
    onMain: true,
    canDispatch: false,
    modelPicker: true,
    dispatch: "none",
  },
];

export function getAgent(id: string): AgentMeta | undefined {
  return AGENTS.find((a) => a.id === id);
}

/* ------------------------------------------------------------------ */
/* Map layout — fixed positions, read left-to-right                    */
/* ------------------------------------------------------------------ */

export type MapNodeDef =
  | {
      id: string;
      kind: "agent";
      agentId: string;
      x: number;
      y: number;
    }
  | {
      id: string;
      kind: "stage";
      label: string;
      sub?: string;
      /** Which live badge to show, if any. */
      badge?: "proposals" | "approved" | "openPRs";
      /** Dashboard section this stage deep-links to. */
      href?: string;
      x: number;
      y: number;
    };

// Rows: main flow at y≈200. Redraft loop below-left. Retro below-right.
// Tool-installer along the top feeding capability arrows down. @mention floats
// top-right as a standalone remote control.
const ROW = 200;

export const MAP_NODES: MapNodeDef[] = [
  { id: "n-scout", kind: "agent", agentId: "scout", x: 0, y: ROW },
  {
    id: "n-ideas",
    kind: "stage",
    label: "Ideas queue",
    sub: "Waiting for you",
    badge: "proposals",
    href: "/ideas",
    x: 230,
    y: ROW,
  },
  {
    id: "n-approve",
    kind: "stage",
    label: "You decide",
    sub: "Approve or send back",
    badge: "approved",
    href: "/ideas",
    x: 460,
    y: ROW,
  },
  { id: "n-redraft", kind: "agent", agentId: "redraft", x: 460, y: ROW + 170 },
  { id: "n-builder", kind: "agent", agentId: "builder", x: 690, y: ROW },
  {
    id: "n-pr",
    kind: "stage",
    label: "Pull request",
    sub: "The proposed change",
    badge: "openPRs",
    href: "/builds",
    x: 920,
    y: ROW,
  },
  { id: "n-audit", kind: "agent", agentId: "audit", x: 1150, y: ROW },
  { id: "n-demo", kind: "agent", agentId: "demo", x: 1380, y: ROW },
  {
    id: "n-final",
    kind: "stage",
    label: "You review & merge",
    sub: "Final approval",
    href: "/builds",
    x: 1610,
    y: ROW,
  },
  {
    id: "n-merged",
    kind: "stage",
    label: "Merged to main",
    sub: "It's live",
    href: "/builds",
    x: 1840,
    y: ROW,
  },
  { id: "n-metrics", kind: "agent", agentId: "metrics", x: 2070, y: ROW },
  // Feedback + support nodes
  { id: "n-retro", kind: "agent", agentId: "retro", x: 1840, y: ROW + 190 },
  { id: "n-tools", kind: "agent", agentId: "toolinstall", x: 690, y: ROW - 190 },
  { id: "n-mention", kind: "agent", agentId: "mention", x: 2070, y: ROW - 190 },
];

export type MapEdgeDef = {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Solid animated flow vs. dashed feedback/capability. */
  variant: "flow" | "feedback" | "capability";
  sourceHandle?: string;
  targetHandle?: string;
};

// Handle ids live on every custom node: sources s-l/s-t/s-r/s-b, targets
// t-l/t-t/t-r/t-b (one per side). Edges pick the pair that reads cleanest.
export const MAP_EDGES: MapEdgeDef[] = [
  { id: "e1", source: "n-scout", target: "n-ideas", variant: "flow", sourceHandle: "s-r", targetHandle: "t-l" },
  { id: "e2", source: "n-ideas", target: "n-approve", variant: "flow", sourceHandle: "s-r", targetHandle: "t-l" },
  { id: "e3", source: "n-approve", target: "n-builder", label: "Approve", variant: "flow", sourceHandle: "s-r", targetHandle: "t-l" },
  { id: "e4", source: "n-approve", target: "n-redraft", label: "Send back", variant: "flow", sourceHandle: "s-b", targetHandle: "t-t" },
  { id: "e5", source: "n-redraft", target: "n-ideas", label: "Rewritten", variant: "flow", sourceHandle: "s-l", targetHandle: "t-b" },
  { id: "e6", source: "n-builder", target: "n-pr", variant: "flow", sourceHandle: "s-r", targetHandle: "t-l" },
  { id: "e7", source: "n-pr", target: "n-audit", variant: "flow", sourceHandle: "s-r", targetHandle: "t-l" },
  { id: "e8", source: "n-audit", target: "n-demo", variant: "flow", sourceHandle: "s-r", targetHandle: "t-l" },
  { id: "e9", source: "n-demo", target: "n-final", variant: "flow", sourceHandle: "s-r", targetHandle: "t-l" },
  { id: "e10", source: "n-final", target: "n-merged", label: "Merge", variant: "flow", sourceHandle: "s-r", targetHandle: "t-l" },
  { id: "e11", source: "n-merged", target: "n-metrics", variant: "flow", sourceHandle: "s-r", targetHandle: "t-l" },
  // Retro reads outcomes and feeds the agents.
  { id: "e12", source: "n-merged", target: "n-retro", variant: "feedback", label: "Learns from", sourceHandle: "s-b", targetHandle: "t-t" },
  { id: "e13", source: "n-retro", target: "n-scout", variant: "feedback", sourceHandle: "s-l", targetHandle: "t-b" },
  { id: "e14", source: "n-retro", target: "n-builder", variant: "feedback", sourceHandle: "s-l", targetHandle: "t-b" },
  { id: "e15", source: "n-retro", target: "n-audit", variant: "feedback", sourceHandle: "s-l", targetHandle: "t-b" },
  // Tool-installer grants capabilities.
  { id: "e16", source: "n-tools", target: "n-scout", variant: "capability", sourceHandle: "s-b", targetHandle: "t-t" },
  { id: "e17", source: "n-tools", target: "n-builder", variant: "capability", sourceHandle: "s-b", targetHandle: "t-t" },
  { id: "e18", source: "n-tools", target: "n-audit", variant: "capability", sourceHandle: "s-b", targetHandle: "t-t" },
];
