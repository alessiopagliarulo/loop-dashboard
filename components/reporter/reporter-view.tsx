"use client";

/**
 * Claude Code Reporter — client view.
 *
 * Renders the cached digest, lets the owner filter by category and source,
 * refresh on demand (re-pulls every source server-side), and optionally ask the
 * AI backend for a plain-English "what's new lately" briefing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  RefreshCw,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  X,
} from "lucide-react";
import { useAiJob } from "@/components/map/use-ai-job";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type Digest,
  type DigestCategory,
  type DigestItem,
} from "@/lib/reporter-types";

const NEW_WINDOW_MS = 48 * 60 * 60 * 1000;

const CATEGORY_STYLES: Record<DigestCategory, string> = {
  "code-release": "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  news: "bg-sky-500/10 text-sky-400 border-sky-500/20",
  technique: "bg-teal-500/10 text-teal-400 border-teal-500/20",
  "ai-news": "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
  mcp: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  "skill-plugin": "bg-amber-500/10 text-amber-400 border-amber-500/20",
  community: "bg-zinc-500/10 text-zinc-300 border-zinc-500/20",
};

function relTime(date: string | null): string {
  if (!date) return "just now";
  const t = Date.parse(date);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function isNew(it: DigestItem): boolean {
  if (it.pinned) return true;
  if (!it.date) return false;
  const t = Date.parse(it.date);
  return !Number.isNaN(t) && Date.now() - t < NEW_WINDOW_MS;
}

export default function ReporterView({
  initialDigest,
}: {
  initialDigest: Digest | null;
}) {
  const [digest, setDigest] = useState<Digest | null>(initialDigest);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<DigestCategory | "all">("all");
  const [source, setSource] = useState<string>("all");

  // Both slow operations run as background jobs on the server, so leaving this
  // page (or the whole browser tab) and coming back re-attaches to them.
  const {
    job: refreshJob,
    submitting: refreshSubmitting,
    submitError: refreshSubmitError,
    start: startRefresh,
    consume: consumeRefresh,
  } = useAiJob({ kind: "reporter-refresh" });
  const {
    job: summaryJobState,
    submitting: summarySubmitting,
    submitError: summarySubmitError,
    start: startSummary,
    consume: consumeSummary,
  } = useAiJob({ kind: "reporter-summary" });
  const handledRefreshId = useRef<string | null>(null);

  // First-ever visit: no cached digest yet, so fetch (server builds it).
  // A cached *partial* digest (cold build that skipped enrichment) also
  // fetches — /api/reporter is the only reader that kicks off the full
  // background refresh, and server-rendering would otherwise bypass it.
  useEffect(() => {
    if (initialDigest && !(initialDigest as { partial?: boolean }).partial) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/reporter");
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(j.error ?? "Couldn't load the digest.");
        setDigest(j.digest);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the digest.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialDigest]);

  const refresh = useCallback(() => {
    setError(null);
    startRefresh("/api/reporter/refresh", {});
  }, [startRefresh]);

  // When a refresh job finishes (even one restored after coming back to this
  // page), pull the freshly persisted digest and mark the job handled.
  useEffect(() => {
    if (!refreshJob || refreshJob.status === "running" || handledRefreshId.current === refreshJob.id)
      return;
    handledRefreshId.current = refreshJob.id;
    if (refreshJob.status === "error") {
      // Folding a finished background job (an external system) into view state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError(refreshJob.error ?? "Refresh failed.");
      consumeRefresh();
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/reporter", { cache: "no-store" });
        const j = await res.json().catch(() => ({}));
        if (res.ok && j.digest) setDigest(j.digest);
      } catch {
        // The digest is persisted server-side — the next visit picks it up.
      }
      consumeRefresh();
    })();
  }, [refreshJob, consumeRefresh]);

  const summarize = useCallback(() => {
    startSummary("/api/reporter/summarize", {});
  }, [startSummary]);

  const refreshing = refreshSubmitting || refreshJob?.status === "running";
  const summarizing = summarySubmitting || summaryJobState?.status === "running";
  const summary =
    summaryJobState?.status === "done"
      ? ((summaryJobState.result as { summary?: string } | undefined)?.summary ?? null)
      : null;
  const summaryError =
    summarySubmitError ??
    refreshSubmitError ??
    (summaryJobState?.status === "error"
      ? (summaryJobState.error ?? "Couldn't summarize.")
      : null);

  // Memoised so a digest-less render doesn't hand every hook below a fresh `[]`.
  const items = useMemo(() => digest?.items ?? [], [digest]);

  // Counts per category / source for the filter chips.
  const catCounts = useMemo(() => {
    const m = new Map<DigestCategory, number>();
    for (const it of items) m.set(it.category, (m.get(it.category) ?? 0) + 1);
    return m;
  }, [items]);

  const sources = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) m.set(it.source, (m.get(it.source) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const filtered = useMemo(
    () =>
      items.filter(
        (it) =>
          (category === "all" || it.category === category) &&
          (source === "all" || it.source === source),
      ),
    [items, category, source],
  );

  const newCount = useMemo(() => items.filter(isNew).length, [items]);
  const failedSources = digest?.sources.filter((s) => !s.ok) ?? [];

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          {digest?.lastUpdated ? (
            <span>Last updated {relTime(digest.lastUpdated)}</span>
          ) : (
            <span>Not loaded yet</span>
          )}
          {newCount > 0 && (
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-400">
              {newCount} new in 48h
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={summarize}
            disabled={summarizing || items.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className={`h-4 w-4 ${summarizing ? "animate-pulse" : ""}`} />
            {summarizing ? "Summarizing…" : "Summarize what's new"}
          </button>
          <button
            onClick={refresh}
            disabled={loading || refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-400 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading || refreshing ? "animate-spin" : ""}`} />
            {loading || refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      </div>

      {/* Background-work note */}
      {(refreshing || summarizing) && (
        <p className="mb-4 text-xs text-zinc-500">
          {summarizing ? "Claude is reading the digest… " : ""}
          Keeps running if you leave this page — come back any time.
        </p>
      )}

      {/* AI summary panel */}
      {(summary || summaryError) && (
        <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <Sparkles className="h-3.5 w-3.5" /> What&apos;s new lately
            </div>
            <button
              onClick={consumeSummary}
              aria-label="Dismiss the briefing"
              title="Dismiss"
              className="rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {summary ? (
            <p className="text-sm leading-relaxed text-zinc-200">{summary}</p>
          ) : (
            <p className="text-sm text-amber-400">{summaryError}</p>
          )}
        </div>
      )}

      {/* Category filter chips */}
      <div className="mb-2 flex flex-wrap gap-2">
        <Chip active={category === "all"} onClick={() => setCategory("all")}>
          All · {items.length}
        </Chip>
        {CATEGORY_ORDER.filter((c) => catCounts.get(c)).map((c) => (
          <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
            {CATEGORY_LABELS[c]} · {catCounts.get(c)}
          </Chip>
        ))}
      </div>

      {/* Source filter chips */}
      {sources.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Chip small active={source === "all"} onClick={() => setSource("all")}>
            All sources
          </Chip>
          {sources.map(([name, count]) => (
            <Chip key={name} small active={source === name} onClick={() => setSource(name)}>
              {name} · {count}
            </Chip>
          ))}
        </div>
      )}

      {/* Failed-source notice (graceful degrade) */}
      {failedSources.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-400/90">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Couldn&apos;t reach: {failedSources.map((s) => s.label).join(", ")}. The rest of the
            digest is up to date.
          </span>
        </div>
      )}

      {/* Errors */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* List */}
      {loading && items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/50 p-8 text-center text-sm text-zinc-500">
          Compiling the latest news… this first pull can take a few seconds.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/50 p-8 text-center text-sm text-zinc-500">
          {items.length === 0
            ? "Nothing here yet. Hit “Refresh now” to pull the latest."
            : "No items match this filter."}
        </div>
      ) : (
        <ul className="space-y-2.5">
          {filtered.map((it) => (
            <ItemCard key={it.id} item={it} />
          ))}
        </ul>
      )}

      {/* Sources footer */}
      {digest && digest.sources.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-800 pt-4 text-[11px] text-zinc-600">
          {digest.sources.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1">
              {s.ok ? (
                <CheckCircle2 className="h-3 w-3 text-emerald-600" />
              ) : (
                <AlertCircle className="h-3 w-3 text-amber-600" />
              )}
              {s.label}
              {s.ok ? ` (${s.count})` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemCard({ item }: { item: DigestItem }) {
  const fresh = isNew(item);
  return (
    <li>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group block rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition hover:border-zinc-700 hover:bg-zinc-800/60"
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${CATEGORY_STYLES[item.category]}`}
          >
            {CATEGORY_LABELS[item.category]}
          </span>
          {fresh && (
            <span className="rounded-md bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-950">
              New
            </span>
          )}
          <span className="text-[11px] text-zinc-500">{item.source}</span>
          <span className="text-[11px] text-zinc-600">·</span>
          <span className="text-[11px] text-zinc-500">{relTime(item.date)}</span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-zinc-100 group-hover:text-white">
            {item.title}
          </h3>
          <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600 group-hover:text-zinc-400" />
        </div>
        {item.summary && (
          <p className="mt-1 line-clamp-3 text-sm text-zinc-400">{item.summary}</p>
        )}
        {item.insight && (
          <p className="mt-1.5 line-clamp-2 text-xs italic text-zinc-500">
            💬 What people say: {item.insight}
          </p>
        )}
      </a>
    </li>
  );
}

function Chip({
  active,
  onClick,
  children,
  small = false,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  small?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border font-medium transition ${
        small ? "px-2.5 py-1 text-[11px]" : "px-3 py-1 text-xs"
      } ${
        active
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
          : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}
