#!/usr/bin/env node
/**
 * Records what the judge harness is measured against, and reads the owner's calls
 * back off that record.
 *
 *   node scripts/judge/snapshot.mjs            offline: re-derive data/judge/labels-github.jsonl
 *                                              from the committed event and PR files
 *   node scripts/judge/snapshot.mjs --fetch    also re-record everything from GitHub first
 *                                              (read-only GraphQL through the gh CLI)
 *
 * What --fetch records:
 *   - from the baseline repo (archived, so its record is frozen): every Scout proposal's
 *     title and body (data/judge/proposals.jsonl) and its label/close history
 *     (data/judge/github-events.jsonl) - the golden set;
 *   - from the baseline repo AND every current target in config/projects.json: every
 *     pull request (data/judge/pull-requests.jsonl), with the issues it builds and, for
 *     loop PRs, whether the judge gate had scored that proposal before the PR opened.
 *     That last field is how the post-gate merge rate accumulates from real runs.
 *
 * Why the golden set is the baseline repo only: its record is frozen, and its calls
 * were made in July 2026 through the dashboard. On the current target, in September,
 * automated workers also acted under the owner's account (the proposals there were
 * closed as obsolete by his "crew" after a rebuild), so that record cannot show that a
 * person made the call. Those proposals are recorded for the merge-rate counts only.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import {
  deriveGithubLabel,
  isScoutProposal,
  linkedIssues,
  ownerCallsWhileOpen,
  proposalId,
} from "../../lib/judge/golden.ts";
import { parseJudgeMarker } from "../../config/loop-template/files/loop-judge.mjs";
import {
  BASELINE_REPO,
  DATA_DIR,
  EVENTS_PATH,
  GITHUB_LABELS_PATH,
  PROPOSALS_PATH,
  PRS_PATH,
  readJsonl,
  rel,
  targetRepos,
  writeJsonl,
} from "./_shared.mjs";

const ISSUES_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    isArchived
    issues(first: 40, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body state createdAt closedAt url
        author { login __typename }
        timelineItems(first: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, CLOSED_EVENT, REOPENED_EVENT]) {
          nodes {
            __typename
            ... on LabeledEvent { createdAt actor { login __typename } label { name } }
            ... on UnlabeledEvent { createdAt actor { login __typename } label { name } }
            ... on ClosedEvent { createdAt actor { login __typename } stateReason }
            ... on ReopenedEvent { createdAt actor { login __typename } }
          }
        }
        comments(first: 100) { nodes { body createdAt author { login __typename } } }
      }
    }
  }
}`;

const PRS_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body state isDraft createdAt closedAt mergedAt headRefName
        author { login __typename }
        mergedBy { login __typename }
      }
    }
  }
}`;

/** REST spells bots `name[bot]`, GraphQL spells them `name`. Keep the REST form everywhere. */
function login(actor) {
  if (!actor?.login) return "ghost";
  return actor.__typename === "Bot" && !actor.login.endsWith("[bot]") ? `${actor.login}[bot]` : actor.login;
}

function graphql(query, owner, name, pick) {
  const out = [];
  let cursor = null;
  let archived = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const res = JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256e6 }));
    if (res.errors?.length) throw new Error(`GitHub GraphQL: ${res.errors.map((e) => e.message).join("; ")}`);
    const repo = res.data.repository;
    archived ??= repo.isArchived ?? null;
    const conn = pick(repo);
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { nodes: out, archived };
}

function fetchIssues(repo) {
  const [owner, name] = repo.split("/");
  const { nodes, archived } = graphql(ISSUES_QUERY, owner, name, (r) => r.issues);
  const issues = nodes.map((n) => ({
    repo,
    number: n.number,
    url: n.url,
    title: n.title ?? "",
    body: n.body ?? "",
    author: login(n.author),
    created_at: n.createdAt,
    closed_at: n.closedAt ?? null,
    state: n.state === "OPEN" ? "open" : "closed",
    events: n.timelineItems.nodes
      .map((e) => ({
        event: { LabeledEvent: "labeled", UnlabeledEvent: "unlabeled", ClosedEvent: "closed", ReopenedEvent: "reopened" }[e.__typename],
        actor: login(e.actor),
        at: e.createdAt,
        ...(e.label ? { label: e.label.name } : {}),
        ...(e.__typename === "ClosedEvent" ? { state_reason: e.stateReason ? e.stateReason.toLowerCase() : null } : {}),
      }))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
    judge_marks: n.comments.nodes
      .map((c) => ({ mark: parseJudgeMarker(c.body), at: c.createdAt }))
      .filter((c) => c.mark)
      .map((c) => ({ verdict: c.mark.verdict, at: c.at, sha: c.mark.sha })),
  }));
  return { issues, archived };
}

function fetchPrs(repo) {
  const [owner, name] = repo.split("/");
  return graphql(PRS_QUERY, owner, name, (r) => r.pullRequests).nodes.map((n) => ({
    repo,
    number: n.number,
    author: login(n.author),
    head_ref: n.headRefName ?? "",
    title: n.title ?? "",
    state: n.state === "OPEN" ? "open" : "closed",
    draft: !!n.isDraft,
    created_at: n.createdAt,
    closed_at: n.closedAt ?? null,
    merged_at: n.mergedAt ?? null,
    merged_by: n.mergedBy ? login(n.mergedBy) : null,
    linked_issues: linkedIssues({ title: n.title, body: n.body, head_ref: n.headRefName }),
  }));
}

/** The judge gate's earliest verdict on any proposal this PR builds, if it came first. */
function gateFor(pr, marksByIssue) {
  const marks = pr.linked_issues
    .flatMap((n) => (marksByIssue.get(n) ?? []).map((m) => ({ ...m, issue: n })))
    .filter((m) => m.at < pr.created_at)
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const last = marks[marks.length - 1];
  return last ? { verdict: last.verdict, judged_at: last.at, issue: last.issue } : null;
}

function fetchAll() {
  const recordedAt = new Date().toISOString();
  mkdirSync(DATA_DIR, { recursive: true });
  const repos = [BASELINE_REPO, ...targetRepos().filter((r) => r !== BASELINE_REPO)];

  const prs = [];
  const proposalHistories = [];
  let proposalRows = [];
  for (const repo of repos) {
    console.log(`Recording ${repo}…`);
    const { issues, archived } = fetchIssues(repo);
    const proposals = issues.filter(isScoutProposal);
    const proposalNumbers = new Set(proposals.map((p) => p.number));
    const marksByIssue = new Map(issues.map((i) => [i.number, i.judge_marks]));
    const repoPrs = fetchPrs(repo).map((pr) => ({
      ...pr,
      builds_proposal: pr.linked_issues.some((n) => proposalNumbers.has(n)),
      gate: gateFor(pr, marksByIssue),
    }));
    prs.push(...repoPrs);
    console.log(`  ${issues.length} issues (${proposals.length} Scout proposals), ${repoPrs.length} PRs, archived=${archived}`);
    if (repo === BASELINE_REPO) {
      if (!archived) console.log(`::warning::${repo} is no longer archived, so its record can change under the numbers.`);
      proposalHistories.push(
        ...proposals.map(({ repo: r, number, author, created_at, closed_at, state, events }) => ({ repo: r, number, author, created_at, closed_at, state, events })),
      );
      proposalRows = proposals.map((p) => ({
        id: proposalId(p.repo, p.number),
        repo: p.repo,
        number: p.number,
        url: p.url,
        filed_at: p.created_at,
        title: p.title,
        body: p.body,
      }));
    }
  }

  writeJsonl(
    PROPOSALS_PATH,
    [
      `Scout proposals from ${BASELINE_REPO} (archived, read-only), recorded ${recordedAt} by scripts/judge/snapshot.mjs --fetch.`,
      "The judge's inputs: title and body as they stand in the archive. No labels here, so the judge can never be shown one.",
    ],
    proposalRows,
  );
  writeJsonl(
    EVENTS_PATH,
    [
      `Label, close and reopen events on every Scout proposal in ${BASELINE_REPO}, recorded ${recordedAt}.`,
      "The owner's calls in labels-github.jsonl are derived from these rows and pull-requests.jsonl, nothing else.",
    ],
    proposalHistories,
  );
  writeJsonl(
    PRS_PATH,
    [
      `Every pull request in ${repos.join(", ")}, recorded ${recordedAt}.`,
      "linked_issues: closing keyword in the body, (#N) in the title, or issue-N in the branch. gate: the judge gate's verdict on a linked proposal, when posted before the PR opened.",
    ],
    prs,
  );
}

function deriveLabels() {
  const histories = readJsonl(EVENTS_PATH);
  const prs = readJsonl(PRS_PATH).filter((p) => p.repo === BASELINE_REPO);
  const owner = BASELINE_REPO.split("/")[0];
  const labels = histories
    .map((issue) => deriveGithubLabel(issue, prs, owner, ownerCallsWhileOpen(issue, histories, owner, issue.closed_at ?? null)))
    .sort((a, b) => a.number - b.number);
  writeJsonl(
    GITHUB_LABELS_PATH,
    [
      `The owner's call on each Scout proposal in ${BASELINE_REPO}, read off his recorded GitHub actions by scripts/judge/snapshot.mjs.`,
      "label_provenance human: every label is an action taken by the owner's account, not assigned by an LLM. The record cannot tell a click by the owner from a tool acting under his account.",
      "label_kind passed-over means never approved, built or declined: silence, NOT an explicit rejection (the declined label was never used on this repo). unambiguous is false for it. Reported separately.",
    ],
    labels,
  );
  const tally = {};
  for (const l of labels) tally[l.label_kind] = (tally[l.label_kind] ?? 0) + 1;
  console.log(`Derived ${labels.length} labels → ${rel(GITHUB_LABELS_PATH)}: ${JSON.stringify(tally)}`);
}

const argv = process.argv.slice(2);
if (argv.includes("--fetch")) fetchAll();
deriveLabels();
