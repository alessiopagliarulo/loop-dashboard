"use client";

import { useState } from "react";
import { Wrench, CheckCircle2, Sparkles } from "lucide-react";
import { useProject } from "@/components/project-context";

const AGENTS: { value: string; label: string; blurb: string }[] = [
  { value: "all", label: "All agents", blurb: "Every agent gets it" },
  { value: "scout", label: "Scout", blurb: "Finds work, files proposals" },
  { value: "builder", label: "Builder", blurb: "Writes code, opens PRs" },
  { value: "audit", label: "Auditor", blurb: "Reviews loop PRs" },
  { value: "retro", label: "Retro", blurb: "Reviews how the loop is doing" },
  { value: "mention", label: "Mention", blurb: "Replies when you write @claude" },
  { value: "demo", label: "Demo", blurb: "Captures screenshots / video" },
];

export default function AddToolForm({ allMode = false }: { allMode?: boolean }) {
  // The install fires at the CURRENT project's repo — never an implicit default.
  const { project } = useProject();
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("all");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validUrl = (() => {
    if (!url.trim()) return false;
    try {
      new URL(url.trim());
      return true;
    } catch {
      return false;
    }
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validUrl) {
      setError("Paste a full web address (starting with https://).");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/tools/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          url: url.trim(),
          target_agent: allMode ? "all" : target,
          notes,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setDone(true);
        setUrl("");
        setNotes("");
      } else {
        setError(data.error ?? "Couldn't start the install.");
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
          <div className="text-sm text-zinc-200">
            <p className="font-semibold text-emerald-300">Off it goes.</p>
            <p className="mt-1 text-zinc-400">
              {allMode
                ? "Claude is wiring this into every agent now. It'll arrive as one build for you to approve, and if it needs anything from you (an account or a key) you'll see a task appear in the "
                : "Claude is researching and installing it now. It'll open a build for you to approve, and if it needs anything from you (an account or a key) you'll see a task appear in the "}
              <strong className="text-zinc-200">Needs you</strong> box below.
            </p>
            <button
              onClick={() => setDone(false)}
              className="mt-3 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
            >
              Add another tool
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-zinc-800 bg-zinc-900 p-5"
    >
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-emerald-400" />
        <h2 className="text-sm font-semibold text-zinc-100">
          {allMode ? "Give ALL agents a new tool" : "Give an agent a new tool"}
        </h2>
      </div>
      {allMode && (
        <p className="mb-3 text-xs text-zinc-400">
          Every agent gets this one. It arrives as a single build to approve. Want it on just one
          agent? Open that agent on the Process Map → Install tools tab.
        </p>
      )}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-400">
          Link to the skill, MCP server, or plugin
        </span>
        <input
          type="text"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/…"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
        />
      </label>

      <div className={`mt-4 ${allMode ? "hidden" : ""}`}>
        <span className="mb-1.5 block text-xs font-medium text-zinc-400">
          Which agent should get it?
        </span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {AGENTS.map((a) => {
            const active = target === a.value;
            return (
              <button
                type="button"
                key={a.value}
                onClick={() => setTarget(a.value)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  active
                    ? "border-emerald-500 bg-emerald-500/10"
                    : "border-zinc-700 bg-zinc-950 hover:bg-zinc-800"
                }`}
              >
                <span className="block text-xs font-semibold text-zinc-100">
                  {a.label}
                </span>
                <span className="block text-[11px] text-zinc-500">
                  {a.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-medium text-zinc-400">
          Anything Claude should know? (optional)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="What you want it used for, gotchas, etc."
          className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
        />
      </label>

      {error && <p className="mt-3 text-xs text-amber-300">{error}</p>}

      <button
        type="submit"
        disabled={busy || !validUrl}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        <Wrench className="h-4 w-4" />
        {busy
          ? "Sending…"
          : allMode
            ? "Install for all agents"
            : "Install this tool"}
      </button>
    </form>
  );
}
