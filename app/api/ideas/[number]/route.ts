import { NextResponse } from "next/server";
import {
  createComment,
  setIssueLabels,
  dispatchWorkflow,
  type RepoConfig,
} from "@/lib/github";
import { listThreadComments, closeIssue, getIssue } from "@/lib/queues";
import { STALE_LABEL } from "@/lib/idea-staleness";
import { COVERED_LABEL } from "@/lib/idea-coverage";
import { resolveProject, resolveProjectFromUrl, ProjectError } from "@/lib/projects";

export const dynamic = "force-dynamic";

/** GET /api/ideas/[number]?project=<key> — the comment thread for one idea. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  const issueNumber = Number(number);
  if (!Number.isInteger(issueNumber)) {
    return NextResponse.json({ error: "Bad issue number" }, { status: 400 });
  }
  try {
    const { repo } = await resolveProjectFromUrl(req.url);
    const comments = await listThreadComments(issueNumber, repo);
    return NextResponse.json({ comments });
  } catch (err) {
    if (err instanceof ProjectError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: msg(err) }, { status: 502 });
  }
}

type ActionBody = {
  /** `reject` is the legacy name for `decline` and behaves identically. */
  action:
    | "approve"
    | "unapprove"
    | "redraft"
    | "decline"
    | "reject"
    | "unstale"
    | "uncover";
  text?: string;
  project?: string;
};

/**
 * Every label this route owns — anything else on the issue is left alone.
 *
 * `stale` is in here even though it is not a queue STATE. It is a warning worn
 * on top of `approved`, and every action below is the owner making a decision
 * about the thing the warning was about — so any of them clears it. Leaving it
 * on through an approve/redraft/decline would leave an amber banner sitting
 * over an idea whose staleness the owner has already answered.
 *
 * `covered` works the same way: approving or redrafting an idea the loop flagged as
 * already covered IS the owner saying "build it anyway" / "rework it", and the loop
 * never re-flags an idea whose flag was cleared (its marker comment stays on the
 * thread, and the workflows check for it).
 */
const QUEUE_LABELS = ["proposal", "approved", "redraft", "declined", "stale", "covered"] as const;

/**
 * The exact label set an issue should end up with after `action`, computed
 * from its CURRENT labels so the write is a single atomic `setLabels` rather
 * than an add + remove pair. Non-queue labels (`bug`, `area/*`, …) survive.
 */
function nextLabels(current: string[], keep: string): string[] {
  const out = current.filter(
    (l) => !(QUEUE_LABELS as readonly string[]).includes(l) || l === keep,
  );
  if (!out.includes(keep)) out.push(keep);
  return out;
}

/**
 * Wake a workflow explicitly instead of trusting the label write to do it.
 *
 * Re-applying a label the issue ALREADY carries emits no `issues: labeled`
 * event, so "approve an already-approved idea" and "send an idea back a second
 * time" were silent no-ops that waited on a cron GitHub drops regularly.
 * `alreadyHad` says whether we are in that case: when the label is genuinely
 * new the label event starts the workflow and dispatching too would just queue
 * a duplicate agent run, so we only dispatch when nothing else will.
 *
 * Best-effort either way — a repo that doesn't have that workflow file must
 * not fail the action the owner actually asked for.
 */
async function wake(
  workflow: string,
  repo: RepoConfig,
  alreadyHad: boolean,
  inputs: Record<string, string> = {},
): Promise<boolean> {
  if (!alreadyHad) return false;
  try {
    await dispatchWorkflow(workflow, "main", inputs, repo);
    return true;
  } catch (err) {
    console.warn(`ideas: couldn't dispatch ${workflow} on ${repo.owner}/${repo.repo}`, err);
    return false;
  }
}

/**
 * POST /api/ideas/[number] — mutate an idea.
 *  approve   : optional comment (e.g. an included chat transcript), labels →
 *              `approved`, then dispatch the Builder
 *  unapprove : labels → `proposal`
 *  redraft   : required feedback comment, labels → `redraft`, then dispatch
 *              the Redraft agent
 *  decline   : optional reason comment, labels → `declined`, close as
 *              `not_planned`. This is the loop's only "no" — the `declined`
 *              label is what makes a rejection legible to the Scout and keeps
 *              the idea in the Closed tab instead of vanishing.
 *  reject    : alias of `decline`, kept for older clients.
 *  unstale   : drop the `stale` warning, leaving the idea approved. The owner
 *              looked at what the Scout flagged and decided the idea still
 *              stands. Nothing else moves.
 *  uncover   : drop the `covered` flag, leaving the idea where it is. The owner
 *              looked at the work the loop said already covers it and disagrees.
 *              The loop will not flag it again.
 *
 * Body carries a `project` field so the mutation targets the right repo.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  const issueNumber = Number(number);
  if (!Number.isInteger(issueNumber)) {
    return NextResponse.json({ error: "Bad issue number" }, { status: 400 });
  }

  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  let repo: RepoConfig;
  try {
    ({ repo } = await resolveProject(body.project));
  } catch (err) {
    if (err instanceof ProjectError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  const action = body.action === "reject" ? "decline" : body.action;
  const text = (body.text ?? "").trim();

  if (action === "redraft" && !text) {
    return NextResponse.json(
      { error: "Feedback is required to send an idea back." },
      { status: 400 },
    );
  }
  if (!["approve", "unapprove", "redraft", "decline", "unstale", "uncover"].includes(action)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  try {
    const current = (await getIssue(issueNumber, repo)).labels;

    switch (action) {
      case "approve": {
        if (text) await createComment(issueNumber, text, repo);
        await setIssueLabels(issueNumber, nextLabels(current, "approved"), repo);
        const dispatched = await wake(
          "claude-builder.yml",
          repo,
          current.includes("approved"),
        );
        return NextResponse.json({ ok: true, dispatched });
      }
      case "unapprove": {
        await setIssueLabels(issueNumber, nextLabels(current, "proposal"), repo);
        return NextResponse.json({ ok: true });
      }
      case "unstale": {
        // "I looked, it's still fine." The idea stays exactly where it is —
        // only the warning comes off. A no-op when the label isn't there, so a
        // double-click or a stale screen can't fail.
        if (!current.includes(STALE_LABEL)) {
          return NextResponse.json({ ok: true, changed: false });
        }
        await setIssueLabels(
          issueNumber,
          current.filter((l) => l !== STALE_LABEL),
          repo,
        );
        return NextResponse.json({ ok: true, changed: true });
      }
      case "uncover": {
        // Same shape as `unstale`: only the flag comes off, and a no-op when it
        // is already gone.
        if (!current.includes(COVERED_LABEL)) {
          return NextResponse.json({ ok: true, changed: false });
        }
        await setIssueLabels(
          issueNumber,
          current.filter((l) => l !== COVERED_LABEL),
          repo,
        );
        return NextResponse.json({ ok: true, changed: true });
      }
      case "redraft": {
        await createComment(
          issueNumber,
          `**Owner feedback for redraft:**\n\n${text}`,
          repo,
        );
        await setIssueLabels(issueNumber, nextLabels(current, "redraft"), repo);
        const dispatched = await wake(
          "claude-redraft.yml",
          repo,
          current.includes("redraft"),
          { issue_number: String(issueNumber) },
        );
        return NextResponse.json({ ok: true, dispatched });
      }
      case "decline": {
        if (text) {
          await createComment(issueNumber, `**Declined by the owner:**\n\n${text}`, repo);
        }
        await setIssueLabels(issueNumber, nextLabels(current, "declined"), repo);
        await closeIssue(issueNumber, "not_planned", repo);
        return NextResponse.json({ ok: true });
      }
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: msg(err) }, { status: 502 });
  }
}

function msg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "GitHub request failed. Try again in a moment.";
}
