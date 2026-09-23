"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Loader2,
  Check,
  ExternalLink,
  AlertTriangle,
  Clock,
  Play,
  Save,
  History,
  Info,
  Sparkles,
  Cpu,
} from "lucide-react";
import type { AgentDetail } from "@/lib/map-types";
import type { LoopConfig } from "@/lib/loop-config";
import {
  ALL_AGENTS_KEY,
  DEFAULT_AGENT_MODEL,
  LOOP_MODELS_PATH,
  MODEL_CHOICES,
  isModelChoice,
  modelLabel,
  resolveAgentModel,
  workflowReadsModelPick,
  type AgentModels,
} from "@/lib/loop-models";
import { relativeTime, duration, runTone } from "./format";
import { InlineDiff } from "./diff";
import HistoryList from "./history-list";
import { useAiJob, formatElapsed } from "./use-ai-job";
import Modal from "./modal";
import CatalogBrowser from "@/components/tools/catalog-browser";

type Tab = "overview" | "instructions" | "model" | "run" | "install" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "instructions", label: "Instructions" },
  { id: "model", label: "Model" },
  { id: "run", label: "Run now" },
  { id: "install", label: "Install tools" },
  { id: "history", label: "History" },
];

/** Agents that can actually receive an installed tool (mirrors TARGET_AGENTS). */
const TOOL_TARGET_AGENTS = new Set(["scout", "builder", "audit", "retro", "mention", "demo"]);

export default function AgentDrawer({
  agentId,
  project,
  onClose,
  onRan,
}: {
  agentId: string | null;
  project: string;
  onClose: () => void;
  onRan?: () => void;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!agentId) return;
      if (!silent) setLoading(true);
      if (!silent) setError(null);
      try {
        const res = await fetch(`/api/map/agent/${agentId}?project=${encodeURIComponent(project)}`);
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? "Couldn't load this agent.");
        }
        setDetail(await res.json());
      } catch (e) {
        // A background refresh failing silently shouldn't blow away an
        // already-loaded panel with an error banner.
        if (!silent) setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [agentId, project],
  );

  useEffect(() => {
    if (agentId) {
      // Reset to a clean panel and fetch when a different agent is opened.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTab("overview");
      setDetail(null);
      load();
    }
  }, [agentId, load]);

  useEffect(() => {
    // Keep "Recent Runs" (and status) live while the drawer is open, instead
    // of freezing on whatever loaded first — mirrors the polling in
    // process-map.tsx so an open drawer can't show a stale run history.
    if (!agentId) return;
    timer.current = setInterval(() => load(true), 20000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [agentId, load]);

  if (!agentId) return null;

  return (
    <Modal onClose={onClose} className="h-[95vh] w-[95vw] sm:h-[85vh] sm:w-[85vw] sm:max-w-[1100px]">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-zinc-100">
            {detail?.meta.label ?? "Loading…"}
          </h2>
          {detail && (
            <p className="mt-0.5 text-xs text-zinc-500">{detail.meta.tagline}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Tabs (scrollable on narrow phones) */}
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-800 px-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative shrink-0 whitespace-nowrap px-3 py-2.5 text-sm font-medium transition ${
              tab === t.id
                ? "text-emerald-400"
                : "text-zinc-500 hover:text-zinc-200"
            }`}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-emerald-400" />
            )}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading && !detail ? (
          <div className="flex items-center gap-2 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : error && !detail ? (
          <ErrorBox message={error} onRetry={() => load()} />
        ) : detail ? (
          <>
            {tab === "overview" && <OverviewTab detail={detail} setTab={setTab} />}
            {tab === "instructions" && (
              <InstructionsTab detail={detail} project={project} onSaved={load} />
            )}
            {tab === "model" && <ModelTab detail={detail} project={project} />}
            {tab === "run" && (
              <RunTab
                detail={detail}
                project={project}
                onRan={() => {
                  load();
                  onRan?.();
                }}
              />
            )}
            {tab === "install" && <InstallToolsTab detail={detail} project={project} />}
            {tab === "history" && (
              <HistoryList file={detail.meta.file} project={project} onRestored={load} />
            )}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function OverviewTab({
  detail,
  setTab,
}: {
  detail: AgentDetail;
  setTab: (tab: Tab) => void;
}) {
  const { tools, mcpServers, skills } = detail.capabilities;
  const capsEmpty = tools.length === 0 && mcpServers.length === 0 && skills.length === 0;
  const isTarget = TOOL_TARGET_AGENTS.has(detail.meta.id);

  return (
    <div className="space-y-5">
      <section>
        <p className="text-sm leading-relaxed text-zinc-300">{detail.meta.description}</p>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          When it runs
        </h3>
        <ul className="space-y-1.5">
          {detail.meta.triggers.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              {t}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Installed
        </h3>
        {capsEmpty ? (
          <p className="text-sm text-zinc-500">
            No special tools or services are configured for this workflow.
          </p>
        ) : (
          <div className="space-y-3">
            <ChipGroup title="Tools" chips={tools} tone="emerald" />
            <ChipGroup title="Connected services (MCP)" chips={mcpServers} tone="sky" />
            <ChipGroup title="Skills" chips={skills} tone="violet" />
          </div>
        )}
        {isTarget ? (
          <button
            onClick={() => setTab("install")}
            className="mt-3 text-xs font-medium text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
          >
            Browse &amp; install tools →
          </button>
        ) : (
          <p className="mt-3 text-xs text-zinc-500">
            This one runs a plain script (or isn&apos;t a tool-using agent), so it can&apos;t take
            extra tools.
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Recent runs
        </h3>
        {detail.runs.length === 0 ? (
          <p className="text-sm text-zinc-500">No runs recorded yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {detail.runs.map((r) => {
              const tone = runTone(r.status, r.conclusion);
              return (
                <li key={r.id}>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm transition hover:border-zinc-700 hover:bg-zinc-800/60"
                  >
                    <StatusDot tone={tone} />
                    <span className="flex-1 text-zinc-300">
                      {tone === "success"
                        ? "Passed"
                        : tone === "failure"
                          ? "Failed"
                          : tone === "running"
                            ? "Running"
                            : "Finished"}
                    </span>
                    <span className="text-xs text-zinc-500">{duration(r.durationSec)}</span>
                    <span className="w-20 text-right text-xs text-zinc-500">
                      {relativeTime(r.createdAt)}
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatusDot({ tone }: { tone: ReturnType<typeof runTone> }) {
  if (tone === "running") return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-400" />;
  const color =
    tone === "success" ? "bg-emerald-400" : tone === "failure" ? "bg-red-400" : "bg-zinc-500";
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />;
}

/* ------------------------------------------------------------------ */
/* Instructions                                                        */
/* ------------------------------------------------------------------ */

function InstructionsTab({
  detail,
  project,
  onSaved,
}: {
  detail: AgentDetail;
  project: string;
  onSaved: () => void;
}) {
  const canFriendly = detail.promptExtractable && detail.prompt !== null;
  // Default to raw when friendly editing isn't available.
  const [rawMode, setRawMode] = useState(!canFriendly);
  const [promptText, setPromptText] = useState(detail.prompt ?? "");
  const [rawText, setRawText] = useState(detail.rawYaml ?? "");
  /**
   * What each editor was loaded with — the two "committed" versions Save is
   * compared against. Kept per mode, because the two editors write different
   * things (a prompt block vs the whole file) and switching between them is
   * not itself an edit. They move forward on a successful save so a second
   * click can't re-commit what was just written.
   */
  const [promptBaseline, setPromptBaseline] = useState(detail.prompt ?? "");
  const [rawBaseline, setRawBaseline] = useState(detail.rawYaml ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ commitUrl: string; historyUrl: string } | null>(null);

  // AI drafting — background job (submit, poll, restore across visits).
  const [aiRequest, setAiRequest] = useState("");
  const {
    job: draftJob,
    submitting: drafting,
    submitError,
    elapsedSec,
    start: startDraftJob,
    consume: consumeDraftJob,
  } = useAiJob({ kind: "draft", agentId: detail.meta.id, project });

  const draftRunning = draftJob?.status === "running";
  const draft =
    draftJob?.status === "done" ? ((draftJob.result as { draft?: string }).draft ?? null) : null;
  const draftError = submitError ?? (draftJob?.status === "error" ? (draftJob.error ?? null) : null);
  /** Which editor the draft belongs to (a restored job remembers its mode). */
  const draftMode: "prompt" | "raw" = draftJob?.input.mode === "raw" ? "raw" : "prompt";

  // A draft restored from an earlier visit may target the other editor mode —
  // switch to it so the preview diff compares like with like.
  useEffect(() => {
    if (draft !== null && canFriendly) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRawMode(draftMode === "raw");
    }
  }, [draft, draftMode, canFriendly]);

  const readOnly = !detail.editable;
  const currentText = rawMode ? rawText : promptText;
  /**
   * Nothing typed yet = nothing to save. Without this the Save button is live
   * the moment the tab opens, so one stray click commits an unchanged file to
   * GitHub — the same rule the template file editor already follows.
   */
  const dirty = currentText !== (rawMode ? rawBaseline : promptBaseline);

  function draftWithAi() {
    startDraftJob(`/api/map/agent/${detail.meta.id}/draft?project=${encodeURIComponent(project)}`, {
      request: aiRequest,
      mode: rawMode ? "raw" : "prompt",
      current: currentText,
    });
  }

  function useDraft() {
    if (draft === null) return;
    if (draftMode === "raw") setRawText(draft);
    else setPromptText(draft);
    setAiRequest("");
    consumeDraftJob();
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const bodyObj = rawMode
        ? { mode: "raw", rawYaml: rawText }
        : { mode: "prompt", prompt: promptText };
      const res = await fetch(
        `/api/map/agent/${detail.meta.id}/instructions?project=${encodeURIComponent(project)}`,
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Couldn't save.");
      setSaved({ commitUrl: j.commitUrl, historyUrl: j.historyUrl });
      // What was just written is the new "unchanged" state, so Save goes back
      // to disabled until something else is typed.
      if (rawMode) setRawBaseline(rawText);
      else setPromptBaseline(promptText);
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {readOnly && (
        <Banner tone="amber">
          These instructions can be read but not changed — this workflow isn&apos;t on the main
          branch yet.
        </Banner>
      )}
      {!detail.fileFound && (
        <Banner tone="red">
          The workflow file couldn&apos;t be found on GitHub.
        </Banner>
      )}
      {detail.fileFound && !canFriendly && (
        <Banner tone="amber">
          {detail.extractionNote
            ? `Simple editing isn't available for this file (${detail.extractionNote}). You're editing the full file directly — change carefully.`
            : "Simple editing isn't available for this file — you're editing the full file directly."}
        </Banner>
      )}

      {!rawMode ? (
        <>
          <label className="block text-xs font-medium text-zinc-400">
            What this agent is told to do. Plain instructions — edit freely.
          </label>
          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            readOnly={readOnly}
            spellCheck={false}
            className="h-72 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs leading-relaxed text-zinc-200 outline-none focus:border-emerald-500/50 disabled:opacity-60"
          />
        </>
      ) : (
        <>
          <label className="block text-xs font-medium text-zinc-400">
            Full workflow file (advanced). This is the raw YAML — a wrong edit can stop the agent
            running.
          </label>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            readOnly={readOnly}
            spellCheck={false}
            className="h-72 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono text-[11px] leading-relaxed text-zinc-200 outline-none focus:border-emerald-500/50 disabled:opacity-60"
          />
        </>
      )}

      {/* Advanced toggle (only when friendly editing is possible) */}
      {canFriendly && (
        <button
          onClick={() => setRawMode((v) => !v)}
          className="text-xs font-medium text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
        >
          {rawMode ? "← Back to simple editing" : "Advanced: edit the full file"}
        </button>
      )}

      {/* Draft with AI */}
      {!readOnly && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
            <Sparkles className="h-3.5 w-3.5 text-emerald-400" /> Draft with AI
          </p>
          {!detail.aiEnabled ? (
            <p className="text-xs text-zinc-500">
              AI drafting runs free through your Claude subscription when the dashboard runs on
              your Mac. In the cloud it needs an Anthropic API key. History and manual editing
              still work.
            </p>
          ) : (
            <>
              <textarea
                value={aiRequest}
                onChange={(e) => setAiRequest(e.target.value)}
                placeholder="Tell Claude what to change about these instructions…"
                rows={2}
                className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500/50"
              />
              <button
                disabled={drafting || draftRunning || !aiRequest.trim()}
                onClick={draftWithAi}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {drafting || draftRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Draft the change
              </button>
              {draftRunning && (
                <div className="mt-2 flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
                  <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                  <span>
                    Claude is drafting… {formatElapsed(elapsedSec)}. Bigger requests can take a
                    few minutes — you can close this panel; the draft will be here when you come
                    back.
                  </span>
                </div>
              )}
              {draftError && (
                <div className="mt-2">
                  <Banner tone="red">
                    {draftError}{" "}
                    {draftJob?.status === "error" && (
                      <button onClick={() => consumeDraftJob()} className="underline">
                        Dismiss
                      </button>
                    )}
                  </Banner>
                </div>
              )}
              {draft !== null && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-zinc-400">
                    Here&apos;s what would change — green lines are added, red lines removed:
                  </p>
                  <InlineDiff oldText={currentText} newText={draft} />
                  <div className="flex gap-2">
                    <button
                      onClick={useDraft}
                      className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-emerald-400"
                    >
                      Use this draft
                    </button>
                    <button
                      onClick={() => consumeDraftJob()}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      Discard
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    Using the draft only fills the editor — you can still tweak it by hand, and
                    nothing is saved until you press Save.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {saveError && <Banner tone="red">{saveError}</Banner>}
      {saved && (
        <Banner tone="emerald">
          Saved to GitHub.{" "}
          <a
            className="underline"
            href={saved.commitUrl}
            target="_blank"
            rel="noreferrer"
          >
            View the change
          </a>
          .
        </Banner>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          disabled={readOnly || saving || !dirty}
          onClick={save}
          title={!readOnly && !dirty ? "Nothing to save — these instructions haven't changed." : undefined}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </button>
        <a
          href={detail.historyUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200"
        >
          <History className="h-3.5 w-3.5" /> History
        </a>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared chips                                                        */
/* ------------------------------------------------------------------ */

function ChipGroup({
  title,
  chips,
  tone,
}: {
  title: string;
  chips: string[];
  tone: "emerald" | "sky" | "violet";
}) {
  if (chips.length === 0) return null;
  const toneCls = {
    emerald: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
    sky: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
    violet: "bg-violet-500/10 text-violet-300 ring-violet-500/30",
  }[tone];
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <span
            key={c}
            className={`rounded-md px-2 py-1 font-mono text-xs ring-1 ring-inset ${toneCls}`}
          >
            {c}
          </span>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Install tools                                                       */
/* ------------------------------------------------------------------ */

function InstallToolsTab({ detail, project }: { detail: AgentDetail; project: string }) {
  const isTarget = TOOL_TARGET_AGENTS.has(detail.meta.id);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isTarget) return;
    let alive = true;
    fetch(`/api/tools/install?project=${encodeURIComponent(project)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (alive) setAvailable(d.available !== false);
      })
      .catch(() => {
        if (alive) setAvailable(true);
      });
    return () => {
      alive = false;
    };
  }, [isTarget, project]);

  if (!isTarget) {
    return (
      <Banner tone="zinc">
        <Info className="mr-1 inline h-3.5 w-3.5" />
        This one runs a plain script (or isn&apos;t a tool-using agent), so it can&apos;t take extra
        tools. Install tools into Scout, Builder, Auditor, Retro, Demo, or @mention instead.
      </Banner>
    );
  }

  if (available === null) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking…
      </div>
    );
  }

  return (
    <CatalogBrowser
      install={{
        mode: "agent",
        agentId: detail.meta.id,
        agentLabel: detail.meta.label,
        project,
        available,
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

/** The two keys this tab edits, as stored (`null` = not picked). */
type ModelPicks = { agent: string | null; all: string | null };

function picksOf(models: AgentModels | undefined, agentId: string): ModelPicks {
  return { agent: models?.[agentId] ?? null, all: models?.[ALL_AGENTS_KEY] ?? null };
}

/** Where a picked model comes from, in the owner's words. */
const SOURCE_TEXT = {
  agent: "picked for this agent",
  all: "the loop default for all agents",
  default: "the built-in default",
} as const;

/**
 * Pick the Claude model this agent runs on, plus the loop default every agent
 * without its own pick falls back to. Writes `.github/loop-config.json` ->
 * `models` through /api/loop-config, the same owner-only route as every other
 * loop setting (a signed-out demo visitor's save is refused by the proxy).
 *
 * The workflow is what honours a pick, so the tab says so plainly when this
 * project's copy of it can't: a workflow from before the picker, or a repo
 * without the list of allowed models.
 */
function ModelTab({ detail, project }: { detail: AgentDetail; project: string }) {
  const { meta } = detail;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ModelPicks | null>(null);
  const [draft, setDraft] = useState<ModelPicks | null>(null);
  const [models, setModels] = useState<AgentModels | undefined>(undefined);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const apply = useCallback(
    (config: LoopConfig, fp: unknown) => {
      const picks = picksOf(config.models, meta.id);
      setModels(config.models);
      setSaved(picks);
      setDraft(picks);
      setFingerprint(typeof fp === "string" ? fp : null);
    },
    [meta.id],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/loop-config?project=${encodeURIComponent(project)}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? "Couldn't load the model settings.");
      apply(payload.config as LoopConfig, payload.fingerprint);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load the model settings.");
    } finally {
      setLoading(false);
    }
  }, [project, apply]);

  useEffect(() => {
    if (!meta.modelPicker) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [meta.modelPicker, load]);

  if (!meta.modelPicker) {
    return (
      <Banner tone="zinc">
        <Info className="mr-1 inline h-3.5 w-3.5" />
        {meta.generic
          ? "This is a custom agent, so its model is set in its own workflow file (Instructions tab), not here."
          : "This one runs a plain script, not a Claude agent, so there's no model to pick."}
      </Banner>
    );
  }
  if (loading && !draft) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (loadError || !draft || !saved) {
    return <ErrorBox message={loadError ?? "Couldn't load the model settings."} onRetry={load} />;
  }

  const current = draft;
  const dirty = current.agent !== saved.agent || current.all !== saved.all;
  const draftModels: AgentModels = {};
  if (current.agent) draftModels[meta.id] = current.agent;
  if (current.all) draftModels[ALL_AGENTS_KEY] = current.all;
  const effective = resolveAgentModel(draftModels, meta.id);
  const allOnly = resolveAgentModel(
    current.all ? { [ALL_AGENTS_KEY]: current.all } : {},
    meta.id,
  );
  const workflowReady = !detail.fileFound || workflowReadsModelPick(detail.rawYaml);

  /** Only the keys that changed, so a save never rewrites what it didn't touch. */
  function patchFor(base: ModelPicks): Record<string, string | null> {
    const patch: Record<string, string | null> = {};
    if (current.agent !== base.agent) patch[meta.id] = current.agent;
    if (current.all !== base.all) patch[ALL_AGENTS_KEY] = current.all;
    return patch;
  }

  async function save(base: ModelPicks, fp: string | null, retried = false): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    setJustSaved(false);
    try {
      const res = await fetch(`/api/loop-config?project=${encodeURIComponent(project)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          models: patchFor(base),
          ...(fp ? { expectedFingerprint: fp } : {}),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 409 && payload?.config) {
        const server = picksOf((payload.config as LoopConfig).models, meta.id);
        setModels((payload.config as LoopConfig).models);
        // Someone saved a different setting (the Scout brief, a cap) in the
        // meantime. Neither key this tab writes moved, so save again once.
        if (!retried && server.agent === base.agent && server.all === base.all) {
          return await save(base, typeof payload.fingerprint === "string" ? payload.fingerprint : null, true);
        }
        // A real clash: keep the owner's choice, rebase what it is compared to.
        setSaved(server);
        setFingerprint(typeof payload.fingerprint === "string" ? payload.fingerprint : null);
        setNotice("The model settings changed somewhere else. Your choice is still here - check it and save again.");
        return;
      }
      if (!res.ok) throw new Error(payload.error ?? "Couldn't save.");
      apply(payload.config as LoopConfig, payload.fingerprint);
      setJustSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  const ignored = resolveAgentModel(models, meta.id).ignored.filter(
    (i) => i.key === meta.id || i.key === ALL_AGENTS_KEY,
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-sm">
        <Cpu className="h-4 w-4 shrink-0 text-emerald-400" />
        <span className="text-zinc-300">
          {meta.label} runs on{" "}
          <span className="font-semibold text-zinc-100">{modelLabel(effective.model)}</span>
        </span>
        <span className="text-xs text-zinc-500">({SOURCE_TEXT[effective.source]})</span>
      </div>

      {detail.fileFound && !workflowReady && (
        <Banner tone="amber">
          This project&apos;s {meta.file} still names its model directly, so a pick here is saved
          but not used until that workflow is updated from the loop template (the Process Map&apos;s
          &quot;Compared with the template&quot; view shows the difference).
        </Banner>
      )}
      {detail.modelsListInstalled === false && (
        <Banner tone="amber">
          This project has no {LOOP_MODELS_PATH}, the list of models the workflows accept, so every
          pick is ignored and each agent stays on {modelLabel(DEFAULT_AGENT_MODEL)}. Add it from the
          loop template&apos;s starting files.
        </Banner>
      )}
      {ignored.map((i) => (
        <Banner key={i.key} tone="amber">
          The loop config sets {i.key === ALL_AGENTS_KEY ? "the all-agents model" : "this agent's model"} to
          &quot;{i.value}&quot;, which isn&apos;t a model the workflows accept, so it is ignored. Pick a
          model below to replace it.
        </Banner>
      ))}

      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          This agent
        </h3>
        <p className="mb-2 text-xs text-zinc-500">
          Applies from the {meta.label}&apos;s next run. Nothing runs when you save.
        </p>
        <div className="space-y-1.5" role="radiogroup" aria-label={`${meta.label} model`}>
          <ModelOption
            name={`model-${meta.id}`}
            checked={current.agent === null}
            onSelect={() => setDraft({ ...current, agent: null })}
            title="Loop default"
            blurb={`Follows the setting for all agents below - currently ${modelLabel(allOnly.model)}.`}
          />
          {MODEL_CHOICES.map((c) => (
            <ModelOption
              key={c.id}
              name={`model-${meta.id}`}
              checked={current.agent === c.id}
              onSelect={() => setDraft({ ...current, agent: c.id })}
              title={c.label}
              blurb={c.blurb}
            />
          ))}
          {current.agent !== null && !isModelChoice(current.agent) && (
            <ModelOption
              name={`model-${meta.id}`}
              checked
              onSelect={() => undefined}
              title={`"${current.agent}"`}
              blurb="Not a model the workflows accept - ignored. Pick another option to replace it."
            />
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          All agents
        </h3>
        <label htmlFor="model-all" className="mb-2 block text-xs text-zinc-500">
          What every agent without its own pick runs on.
        </label>
        <select
          id="model-all"
          value={current.all ?? ""}
          onChange={(e) => setDraft({ ...current, all: e.target.value || null })}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-500/50 sm:w-72"
        >
          <option value="">Built-in default ({modelLabel(DEFAULT_AGENT_MODEL)})</option>
          {MODEL_CHOICES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
          {current.all !== null && !isModelChoice(current.all) && (
            <option value={current.all}>&quot;{current.all}&quot; (ignored)</option>
          )}
        </select>
      </section>

      {notice && <Banner tone="amber">{notice}</Banner>}
      {saveError && <Banner tone="red">{saveError}</Banner>}
      {justSaved && !dirty && (
        <Banner tone="emerald">
          Saved. The {meta.label} runs on {modelLabel(effective.model)} from its next run.
        </Banner>
      )}

      <button
        disabled={saving || !dirty}
        onClick={() => save(saved, fingerprint)}
        title={!dirty ? "Nothing to save - the model settings haven't changed." : undefined}
        className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save
      </button>
    </div>
  );
}

function ModelOption({
  name,
  checked,
  onSelect,
  title,
  blurb,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  blurb: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition ${
        checked
          ? "border-emerald-500/50 bg-emerald-500/10"
          : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"
      }`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 accent-emerald-500"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-100">{title}</span>
        <span className="block text-xs leading-relaxed text-zinc-400">{blurb}</span>
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Run now                                                             */
/* ------------------------------------------------------------------ */

function RunTab({
  detail,
  project,
  onRan,
}: {
  detail: AgentDetail;
  project: string;
  onRan: () => void;
}) {
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const { meta } = detail;

  if (!meta.canDispatch) {
    return (
      <div className="space-y-3">
        <Banner tone="zinc">
          <Info className="mr-1 inline h-3.5 w-3.5" />
          This one can&apos;t be started by hand from here — it runs automatically on its own
          triggers (see the Overview tab).
        </Banner>
      </div>
    );
  }

  if (!meta.onMain) {
    return (
      <Banner tone="amber">
        This project doesn&apos;t have this agent installed yet. Onboard it from
        the Projects menu, and a &quot;Run now&quot; button will appear here.
      </Banner>
    );
  }

  const needsInput = meta.dispatch !== "none";

  async function run() {
    setRunning(true);
    setRunError(null);
    setStarted(false);
    try {
      const res = await fetch(`/api/map/agent/${meta.id}/dispatch?project=${encodeURIComponent(project)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(needsInput ? { input } : {}),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Couldn't start the run.");
      setStarted(true);
      onRan();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Couldn't start the run.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        Start this agent right now, without waiting for its usual trigger.
      </p>

      {needsInput && (
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">
            {meta.dispatchInputLabel ?? "Number"}
          </label>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            inputMode="numeric"
            placeholder="e.g. 42"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-500/50"
          />
          {meta.dispatchInputHelp && (
            <p className="mt-1 text-xs text-zinc-500">{meta.dispatchInputHelp}</p>
          )}
        </div>
      )}

      {runError && <Banner tone="red">{runError}</Banner>}
      {started && (
        <Banner tone="emerald">
          Started. The new run will show up in the Overview tab&apos;s recent runs in a few seconds.
        </Banner>
      )}

      <button
        disabled={running || (needsInput && !input.trim())}
        onClick={run}
        className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        Run now
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function Banner({
  tone,
  children,
}: {
  tone: "amber" | "red" | "emerald" | "zinc";
  children: React.ReactNode;
}) {
  const cls = {
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    red: "border-red-500/30 bg-red-500/10 text-red-200",
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    zinc: "border-zinc-700 bg-zinc-800/50 text-zinc-300",
  }[tone];
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${cls}`}>
      {(tone === "amber" || tone === "red") && (
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      {tone === "emerald" && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <div>{children}</div>
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-3 py-8 text-center">
      <AlertTriangle className="mx-auto h-8 w-8 text-red-400" />
      <p className="text-sm text-zinc-300">{message}</p>
      <button
        onClick={onRetry}
        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
      >
        Try again
      </button>
    </div>
  );
}
