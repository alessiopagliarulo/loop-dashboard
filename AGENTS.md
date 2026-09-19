<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Done means seen working

A change is **done** when you have seen it working in the running app. Typecheck, lint, build
and tests passing is the floor, not the bar — four handoffs in a row shipped features nobody
had ever rendered.

- **Page or component:** open it in the running app with real data (the `run` skill, or a
  Playwright screenshot) and look at it.
- **API route:** call it against the running app and read the response.
- **Workflow or script:** run it, or cite the run that exercised it.

Every summary and handoff names what you opened and what you saw. Anything you could not see
goes under **Not yet seen** as an open item, so the next session picks it up rather than
inheriting it as finished.

## Agent skills

### Issue tracker

Local markdown under `.scratch/`, gitignored: this repo is public, so tickets stay on this machine. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), set as a `Status:` line in each ticket. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root; decisions in `docs/design-decisions.md`. See `docs/agents/domain.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
