"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  ThumbsUp,
  Undo2,
  CornerUpLeft,
  X,
  ExternalLink,
  AlertTriangle,
  Check,
  Link2,
} from "lucide-react";
import type { IdeaSummary, ThreadComment } from "@/lib/queues";
import type { DuplicateReport } from "@/lib/dedup/queue-duplicates";
import { Markdown, relativeTime, Spinner, ErrorPanel } from "./ui";
import { DuplicateStrip } from "./duplicate-hint";
import CommentThread from "./comment-thread";
import IdeaChat from "./idea-chat";
import { useIdeaChat } from "./use-idea-chat";
import { useToast } from "./toast";

type ActionKind = "approve" | "unapprove" | "redraft" | "decline" | "unstale" | "uncover";

/**
 * The warning the Scout's stale check leaves on an approved idea whose code has
 * moved underneath it. A plain literal for the same reason the four queue
 * labels below are: this is a client component, and the canonical constant
 * (`STALE_LABEL` in lib/idea-staleness.ts) lives in a module that imports
 * Octokit, which has no business in the browser bundle.
 */
const STALE_LABEL = "stale";

/**
 * The loop's "existing work already does this" flag. A literal for the same reason
 * as STALE_LABEL; the canonical one is `COVERED_LABEL` in lib/idea-coverage.ts.
 */
const COVERED_LABEL = "covered";

/**
 * The chip reads as the idea's CURRENT state, so a closed issue may never wear
 * a live-state colour. "Approved"/"Waiting for you" on something closed a month
 * ago flatly contradicts the "closed …" line right below it. A closed idea
 * therefore always says Closed, in neutral zinc, and carries what it was
 * labelled as a past-tense suffix instead of a second, competing chip.
 */
function labelBadge(labels: string[], state: "open" | "closed") {
  if (labels.includes("declined"))
    return { text: "Declined", cls: "bg-red-500/15 text-red-300" };
  if (state === "closed") {
    const was = labels.includes("proposal")
      ? "was waiting on you"
      : labels.includes("approved")
        ? "was approved"
        : labels.includes("redraft")
          ? "was being redrafted"
          : null;
    return {
      text: was ? `Closed · ${was}` : "Closed",
      cls: "bg-zinc-700/40 text-zinc-400",
    };
  }
  if (labels.includes("proposal"))
    return { text: "Waiting for you", cls: "bg-amber-500/15 text-amber-300" };
  if (labels.includes("approved"))
    return { text: "Approved", cls: "bg-emerald-500/15 text-emerald-300" };
  if (labels.includes("redraft"))
    return { text: "Being redrafted", cls: "bg-sky-500/15 text-sky-300" };
  return { text: "Closed", cls: "bg-zinc-700/40 text-zinc-400" };
}

export default function IdeaCard({
  idea,
  project,
  onChanged,
  duplicates = null,
}: {
  idea: IdeaSummary;
  project: string;
  onChanged: () => void;
  /**
   * The whole queue's duplicate report, or null when there isn't one. Passed
   * down rather than fetched here: it is computed once for the queue, and a
   * per-card fetch would be N requests for one answer.
   */
  duplicates?: DuplicateReport | null;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<ThreadComment[] | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"feedback" | "decline" | null>(null);
  const [panelText, setPanelText] = useState("");
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const chat = useIdeaChat(project, idea.number);

  // Belt and braces: ideas-view keys cards by `${project}:${number}` so this
  // component remounts on a switch, but if a card is ever reused for a
  // DIFFERENT issue, none of the previous issue's thread or half-typed
  // feedback may survive into it.
  const identity = `${project}:${idea.number}`;
  const identityRef = useRef(identity);
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    setComments(null);
    setCommentsError(null);
    setLoadingComments(false);
    setPanel(null);
    setPanelText("");
    setBusy(null);
    setOpen(false);
  }, [identity]);

  const badge = labelBadge(idea.labels, idea.state);
  const isProposal = idea.labels.includes("proposal") && idea.state === "open";
  const isApproved =
    idea.labels.includes("approved") &&
    !idea.labels.includes("proposal") &&
    idea.state === "open";
  // Only ever shown on a LIVE idea. A closed one already reads "Closed · was
  // approved", and warning someone that a decision they already made might be
  // out of date is noise, not information.
  const isStale = isApproved && idea.labels.includes(STALE_LABEL);
  // Same rule: only a live idea can be "already covered". Closed ones are decided.
  const isCovered = idea.state === "open" && idea.labels.includes(COVERED_LABEL);
  const coverLinks = idea.coveredBy ?? [];

  async function loadComments() {
    if (comments || loadingComments) return;
    setLoadingComments(true);
    setCommentsError(null);
    try {
      const res = await fetch(
        `/api/ideas/${idea.number}?project=${encodeURIComponent(project)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load comments");
      setComments(data.comments as ThreadComment[]);
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoadingComments(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) loadComments();
  }

  /** Append the private chat transcript to `text`, when included and present. */
  function withChat(text: string): string {
    if (!chat.includeInAction || !chat.hasContent) return text;
    const block = `**Chat with Claude before deciding:**\n\n${chat.transcriptText}`;
    return text ? `${text}\n\n---\n\n${block}` : block;
  }

  async function act(
    action: ActionKind,
    opts: { text?: string } = {},
  ): Promise<boolean> {
    setBusy(action);
    try {
      const res = await fetch(`/api/ideas/${idea.number}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, project, ...opts }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Action failed");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (await act("approve", { text: withChat("") })) {
      toast.success(
        "Approved — the Builder will start on this within a minute (or trigger it from Testing).",
      );
      chat.clear();
      onChanged();
    }
  }

  async function dismissStale() {
    if (await act("unstale")) {
      toast.success("Cleared. It stays approved and the Builder will still build it.");
      onChanged();
    }
  }

  async function dismissCovered() {
    if (await act("uncover")) {
      toast.success("Cleared. The loop won't flag this one as covered again.");
      onChanged();
    }
  }

  async function unapprove() {
    if (await act("unapprove")) {
      toast.success("Moved back to “Waiting for you”.");
      onChanged();
    }
  }

  async function submitFeedback() {
    if (!panelText.trim()) {
      toast.error("Add some feedback so the agent knows what to change.");
      return;
    }
    if (await act("redraft", { text: withChat(panelText.trim()) })) {
      toast.success(
        "Sent back. The agent will rewrite this idea and it'll return to “Waiting for you”.",
      );
      setPanel(null);
      setPanelText("");
      chat.clear();
      onChanged();
    }
  }

  async function submitDecline() {
    if (await act("decline", { text: withChat(panelText.trim()) || undefined })) {
      toast.success(
        "Declined. The Scout sees this as a “no” and won't keep proposing it.",
      );
      setPanel(null);
      setPanelText("");
      chat.clear();
      onChanged();
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      {/* Header */}
      <button
        onClick={toggle}
        className="flex w-full items-start gap-3 p-4 text-left transition hover:bg-zinc-800/40"
      >
        <span className="mt-0.5 shrink-0 text-zinc-500">
          {open ? (
            <ChevronDown className="h-5 w-5" />
          ) : (
            <ChevronRight className="h-5 w-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}
            >
              {badge.text}
            </span>
            {/* A second chip rather than a replacement for the first: this idea
                really is still approved and still in the Builder's path. The
                warning sits ON TOP of that state, it does not replace it. */}
            {isStale && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
                <AlertTriangle className="h-3 w-3" />
                May be out of date
              </span>
            )}
            {isCovered && (
              <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-xs font-medium text-violet-300">
                <Link2 className="h-3 w-3" />
                Already covered
              </span>
            )}
            <span className="text-xs text-zinc-500">#{idea.number}</span>
          </div>
          <p className="mt-1.5 font-medium leading-snug text-zinc-100">
            {idea.title}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span>opened {relativeTime(idea.createdAt)}</span>
            {idea.state === "closed" && idea.closedAt && (
              <span>closed {relativeTime(idea.closedAt)}</span>
            )}
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="h-3.5 w-3.5" />
              {idea.commentCount}
            </span>
          </div>
        </div>
      </button>

      {/* Near-duplicates, from the embedding index. Outside the header button
          (a link cannot live inside one) and outside the `open` branch, so the
          owner sees it without expanding the card. Absent whenever there is no
          index — never an error state. */}
      {/* What already covers it — a PR, a branch, a merge, another idea — as links,
          outside the header button for the same reason as the duplicate strip. */}
      {isCovered && (
        <div className="border-t border-violet-500/20 bg-violet-500/[0.06] px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Link2 className="h-3.5 w-3.5 text-violet-300" />
            <span className="text-xs font-semibold uppercase tracking-wide text-violet-300">
              Already covered by
            </span>
          </div>
          {coverLinks.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {coverLinks.map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group -mx-1.5 flex items-start gap-2 rounded-lg px-1.5 py-1 transition hover:bg-violet-500/10"
                  >
                    <span className="min-w-0 flex-1 break-words text-sm leading-snug text-zinc-300 group-hover:text-zinc-100">
                      {link.text}
                    </span>
                    <ExternalLink className="mt-1 h-3 w-3 shrink-0 text-zinc-600 group-hover:text-violet-300" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-sm text-zinc-400">
              The loop&apos;s note on GitHub says what — open the card to read it.
            </p>
          )}
        </div>
      )}

      {duplicates && (
        <DuplicateStrip
          matches={duplicates.pairs[String(idea.number)] ?? []}
          report={duplicates}
        />
      )}

      {/* Expanded */}
      {open && (
        <div className="border-t border-zinc-800 p-4">
          {/* Stale warning. Same amber treatment as the PR card's "falling
              behind main" banner on purpose — they are the same idea (something
              that was fine when it was filed and may not be now), so they should
              read as one system. The WHY lives in the Scout's comment down in
              "Activity on GitHub"; repeating it here would mean fetching and
              parsing a comment a model wrote, and it would go stale itself. */}
          {isStale && (
            <div className="mb-4 rounded-xl border border-amber-700 bg-amber-950/40 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                ⏳ Code has landed since you approved this — it may already be
                done, or no longer the right thing to build.
              </p>
              <p className="mt-1 text-sm text-amber-300/90">
                The Scout left a note below saying exactly what changed. It is a
                heads-up, not a verdict — a commit touching a file this idea
                mentions is evidence, not proof. Nothing has been closed or moved:
                the Builder will still build this unless you say otherwise.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => {
                    setPanel(panel === "feedback" ? null : "feedback");
                    setPanelText("");
                  }}
                  disabled={busy !== null}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-700 bg-amber-900/40 px-4 py-2.5 text-sm font-semibold text-amber-100 transition hover:bg-amber-900/70 disabled:opacity-50"
                >
                  <CornerUpLeft className="h-4 w-4" />
                  Send back with feedback
                </button>
                <button
                  onClick={dismissStale}
                  disabled={busy !== null}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
                >
                  {busy === "unstale" ? <Spinner /> : <Check className="h-4 w-4" />}
                  It&apos;s still fine — clear this
                </button>
              </div>
            </div>
          )}

          {isCovered && (
            <div className="mb-4 rounded-xl border border-violet-700 bg-violet-950/40 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-violet-200">
                <Link2 className="h-4 w-4 shrink-0" />
                Work that already exists seems to do this.
              </p>
              <p className="mt-1 text-sm text-violet-300/90">
                The loop found an open or merged PR, a pushed branch, or another idea that
                covers it, and linked it above. It is a flag, not a verdict: nothing was
                closed, and the Builder skips this idea while the flag is on. Decline it
                if it really is covered, or clear the flag to keep it.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={dismissCovered}
                  disabled={busy !== null}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
                >
                  {busy === "uncover" ? <Spinner /> : <Check className="h-4 w-4" />}
                  Not covered — keep it
                </button>
              </div>
            </div>
          )}

          <div className="mb-2 flex justify-end">
            <a
              href={idea.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-emerald-400"
            >
              Open on GitHub <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {idea.body.trim() ? (
            <Markdown>{idea.body}</Markdown>
          ) : (
            <p className="text-sm text-zinc-500">No description.</p>
          )}

          {/* Private chat — think it through before deciding */}
          {idea.state === "open" && (
            <div className="mt-4">
              <IdeaChat chat={chat} />
            </div>
          )}

          {/* Actions */}
          {isProposal && (
            <div className="mt-4 space-y-2">
              {chat.hasContent && (
                <p className="text-xs text-zinc-500">
                  {chat.includeInAction
                    ? "Your chat with Claude will be included with whatever you do next."
                    : "Your chat with Claude will stay private — nothing from it will be sent."}
                </p>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  onClick={approve}
                  disabled={busy !== null}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy === "approve" ? <Spinner /> : <ThumbsUp className="h-4 w-4" />}
                  Approve
                </button>
                <button
                  onClick={() => {
                    setPanel(panel === "feedback" ? null : "feedback");
                    setPanelText("");
                  }}
                  disabled={busy !== null}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-sky-700 bg-sky-950/40 px-4 py-3 text-sm font-semibold text-sky-200 transition hover:bg-sky-900/40 disabled:opacity-50"
                >
                  <CornerUpLeft className="h-4 w-4" />
                  Send back with feedback
                </button>
              </div>
              <button
                onClick={() => {
                  setPanel(panel === "decline" ? null : "decline");
                  setPanelText("");
                }}
                disabled={busy !== null}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-red-900 px-4 py-2.5 text-sm font-medium text-red-300 transition hover:bg-red-950/40 disabled:opacity-50"
              >
                <X className="h-4 w-4" />
                Decline
              </button>
            </div>
          )}

          {isApproved && (
            <div className="mt-4">
              <button
                onClick={unapprove}
                disabled={busy !== null}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy === "unapprove" ? <Spinner /> : <Undo2 className="h-4 w-4" />}
                Un-approve (back to waiting)
              </button>
            </div>
          )}

          {/* Feedback / decline text panel */}
          {panel && (
            <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                {panel === "feedback"
                  ? "What should the agent change? (required)"
                  : "Why not? One line is enough (optional)"}
              </label>
              {panel === "feedback" ? (
                <textarea
                  value={panelText}
                  onChange={(e) => setPanelText(e.target.value)}
                  rows={4}
                  placeholder="e.g. Good idea, but scope it to just the sports channel first…"
                  className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none"
                />
              ) : (
                <input
                  value={panelText}
                  onChange={(e) => setPanelText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitDecline();
                    }
                  }}
                  placeholder="e.g. Duplicate of #12 — or: we're not touching billing"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-600 focus:outline-none"
                />
              )}
              {panel === "decline" && (
                <p className="mt-1.5 text-xs text-zinc-500">
                  This closes the idea as a real &ldquo;no&rdquo; — the Scout reads declined
                  ideas so it stops proposing the same thing.
                </p>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <button
                  onClick={() => {
                    setPanel(null);
                    setPanelText("");
                  }}
                  className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  onClick={panel === "feedback" ? submitFeedback : submitDecline}
                  disabled={busy !== null}
                  className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                    panel === "feedback"
                      ? "bg-sky-600 hover:bg-sky-500"
                      : "bg-red-600 hover:bg-red-500"
                  }`}
                >
                  {busy === "redraft" || busy === "decline" ? <Spinner /> : null}
                  {panel === "feedback" ? "Send back for redraft" : "Decline & close"}
                </button>
              </div>
            </div>
          )}

          {/* The real, posted GitHub history — separate from the private chat above */}
          <div className="mt-5">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Activity on GitHub
            </h4>
            {commentsError ? (
              <ErrorPanel
                message={commentsError}
                onRetry={() => {
                  setComments(null);
                  loadComments();
                }}
              />
            ) : (
              <CommentThread
                comments={comments ?? []}
                loading={loadingComments && !comments}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
