import { NextResponse } from "next/server";
import { getFileContent, getWorkflowRuns } from "@/lib/github";
import { parseCapabilities } from "@/lib/map-capabilities";
import { extractPrompt } from "@/lib/map-yaml";
import { aiEnabled } from "@/lib/map-ai";
import { resolveProjectFromUrl, findProjectAgent, ProjectError } from "@/lib/projects";
import type { AgentDetail, RunSummary } from "@/lib/map-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/map/agent/[id]?project=<key>
 * Everything the drawer needs in one shot: description + triggers (from meta),
 * last 5 runs, capabilities, and the workflow YAML with a friendly prompt
 * extracted when possible. Works for baseline agents and per-project custom
 * (generic) agents alike.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const { project, repo } = await resolveProjectFromUrl(req.url);
    const meta = await findProjectAgent(project, id);
    if (!meta) {
      return NextResponse.json({ error: "Unknown agent." }, { status: 404 });
    }

    const path = `.github/workflows/${meta.file}`;
    const ref = "main";
    const rawYaml = await getFileContent(path, ref, repo);
    const mcpJson = await getFileContent(".mcp.json", "main", repo).catch(() => null);

    let runs: RunSummary[] = [];
    try {
      const raw = await getWorkflowRuns({ workflowId: meta.file, per_page: 5, repo });
      runs = raw.map(toRunSummary);
    } catch {
      runs = []; // Workflow may not be registered on GitHub yet.
    }

    const extraction = rawYaml
      ? extractPrompt(rawYaml)
      : ({ ok: false, reason: "File not found." } as const);
    const capabilities = parseCapabilities(rawYaml, mcpJson);
    const editable = rawYaml !== null;

    const detail: AgentDetail = {
      meta,
      runs,
      capabilities,
      ref,
      fileFound: rawYaml !== null,
      prompt: extraction.ok ? extraction.prompt : null,
      rawYaml,
      promptExtractable: extraction.ok,
      extractionNote: extraction.ok ? undefined : extraction.reason,
      editable,
      historyUrl: `https://github.com/${repo.owner}/${repo.repo}/commits/${ref}/${path}`,
      aiEnabled: aiEnabled(),
    };
    return NextResponse.json(detail);
  } catch (err) {
    if (err instanceof ProjectError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    console.error(`agent[${id}]: fatal`, err);
    return NextResponse.json(
      { error: "Couldn't load this agent from GitHub. Try again in a moment." },
      { status: 502 },
    );
  }
}

type RawRun = {
  id: number;
  status: string | null;
  conclusion: string | null;
  created_at?: string | null;
  run_started_at?: string | null;
  updated_at?: string | null;
  html_url: string;
};

function toRunSummary(r: RawRun): RunSummary {
  const start = r.run_started_at ?? r.created_at ?? null;
  const end = r.updated_at ?? null;
  let durationSec: number | null = null;
  if (start && end) {
    const d = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
    durationSec = d >= 0 ? d : null;
  }
  return {
    id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
    durationSec,
    url: r.html_url,
  };
}
