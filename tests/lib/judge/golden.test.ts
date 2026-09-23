/**
 * The judge's golden set: how the owner's call is read off the GitHub record, and the
 * guarantees about the committed files that every reported number rests on.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LOOP_AUTHOR_PATTERNS as TEMPLATE_PATTERNS } from "../../../config/loop-template/files/loop-inflight.mjs";
import {
  deriveGithubLabel,
  handLabel,
  isScoutProposal,
  linkedIssues,
  ownerCallsWhileOpen,
  validateLabel,
  type RecordedEvent,
  type RecordedIssue,
  type RecordedPr,
} from "../../../lib/judge/golden";
import { LOOP_AUTHOR_PATTERNS as MERGE_RATE_PATTERNS } from "../../../lib/judge/merge-rate";

const ROOT = join(__dirname, "..", "..", "..");
const REPO = "acme/shop";
const OWNER = "acme";

const ev = (event: RecordedEvent["event"], actor: string, at: string, extra: Partial<RecordedEvent> = {}): RecordedEvent => ({
  event,
  actor,
  at,
  ...extra,
});

const filed = ev("labeled", "claude[bot]", "2026-07-01T00:00:00Z", { label: "proposal" });

function issue(number: number, events: RecordedEvent[], over: Partial<RecordedIssue> = {}): RecordedIssue {
  return { repo: REPO, number, author: "claude[bot]", created_at: "2026-07-01T00:00:00Z", state: "open", events: [filed, ...events], ...over };
}

function pr(number: number, over: Partial<RecordedPr> = {}): RecordedPr {
  return {
    repo: REPO,
    number,
    author: "claude[bot]",
    head_ref: `claude/thing-${number}`,
    title: "Thing",
    state: "closed",
    draft: false,
    created_at: "2026-07-02T00:00:00Z",
    closed_at: "2026-07-03T00:00:00Z",
    merged_at: null,
    merged_by: null,
    linked_issues: [],
    ...over,
  };
}

function readRows(file: string) {
  return readFileSync(join(ROOT, file), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => JSON.parse(l));
}

describe("linkedIssues", () => {
  it("reads closing keywords, a (#N) title and an issue-N branch - not a bare mention", () => {
    expect(linkedIssues({ body: "Closes #12. Fixes: #3, resolved #4", title: "", head_ref: "" })).toEqual([3, 4, 12]);
    expect(linkedIssues({ body: "", title: "Stop X (#21)", head_ref: "claude/issue-15-foo" })).toEqual([15, 21]);
    expect(linkedIssues({ body: "Refs #8 and see step #2", title: "", head_ref: "claude/fix-utf-8" })).toEqual([]);
  });
});

describe("isScoutProposal", () => {
  it("needs a loop author AND the proposal label from the loop", () => {
    expect(isScoutProposal(issue(1, []))).toBe(true);
    expect(isScoutProposal(issue(2, [], { author: OWNER }))).toBe(false);
    expect(isScoutProposal({ ...issue(3, []), events: [] })).toBe(false);
    expect(isScoutProposal({ ...issue(4, []), events: [ev("labeled", OWNER, "2026-07-01T00:00:00Z", { label: "proposal" })] })).toBe(false);
  });
});

describe("deriveGithubLabel", () => {
  it("the owner's last explicit call wins, and is unambiguous", () => {
    // Closed as not planned, reopened, then approved: the approval is the call.
    const l = deriveGithubLabel(
      issue(18, [
        ev("closed", OWNER, "2026-07-02T00:00:00Z", { state_reason: "not_planned" }),
        ev("reopened", OWNER, "2026-07-02T01:00:00Z"),
        ev("labeled", OWNER, "2026-07-02T02:00:00Z", { label: "approved" }),
      ]),
      [],
      OWNER,
    );
    expect(l).toMatchObject({ label: "approve", label_kind: "approved", unambiguous: true, label_provenance: "human", label_source: "github-record", decided_by: OWNER });
    const d = deriveGithubLabel(
      issue(5, [ev("labeled", OWNER, "2026-07-02T00:00:00Z", { label: "approved" }), ev("labeled", OWNER, "2026-07-03T00:00:00Z", { label: "declined" })]),
      [],
      OWNER,
    );
    expect(d).toMatchObject({ label: "not-now", label_kind: "declined", unambiguous: true });
  });

  it("an approval by anyone but the owner does not count", () => {
    const l = deriveGithubLabel(issue(6, [ev("labeled", "github-actions[bot]", "2026-07-02T00:00:00Z", { label: "approved" })]), [], OWNER);
    expect(l.label_kind).toBe("passed-over");
  });

  it("a merged build of an unlabelled proposal is an explicit approve", () => {
    const l = deriveGithubLabel(issue(14, []), [pr(23, { merged_at: "2026-07-03T00:00:00Z", merged_by: OWNER, linked_issues: [14] })], OWNER);
    expect(l).toMatchObject({ label: "approve", label_kind: "merged-build", unambiguous: true, decided_at: "2026-07-03T00:00:00Z" });
  });

  it("closed-as-not-planned and closed builds are 'not now' but NOT unambiguous", () => {
    const closed = deriveGithubLabel(
      issue(3, [ev("closed", OWNER, "2026-07-02T00:00:00Z", { state_reason: "not_planned" })], { state: "closed" }),
      [],
      OWNER,
    );
    expect(closed).toMatchObject({ label: "not-now", label_kind: "closed-not-planned", unambiguous: false });
    const built = deriveGithubLabel(issue(9, []), [pr(40, { linked_issues: [9] })], OWNER);
    expect(built).toMatchObject({ label: "not-now", label_kind: "build-closed", unambiguous: false });
  });

  it("silence is 'passed over': not now, not unambiguous, and it says it is an assumption", () => {
    const l = deriveGithubLabel(issue(85, [ev("labeled", OWNER, "2026-07-02T00:00:00Z", { label: "redraft" })]), [pr(41, { state: "open", closed_at: null, linked_issues: [99] })], OWNER);
    expect(l).toMatchObject({ label: "not-now", label_kind: "passed-over", unambiguous: false, decided_by: null });
    expect(l.note).toMatch(/assumption/);
    expect(l.evidence.join(" ")).toMatch(/sent back for a redraft/);
  });
});

describe("ownerCallsWhileOpen", () => {
  it("counts the owner's approve/decline calls on other proposals while this one was open", () => {
    const a = issue(1, [], { created_at: "2026-07-01T00:00:00Z" });
    const b = issue(2, [ev("labeled", OWNER, "2026-07-05T00:00:00Z", { label: "approved" })]);
    const c = issue(3, [ev("labeled", OWNER, "2026-06-30T00:00:00Z", { label: "approved" }), ev("labeled", OWNER, "2026-07-06T00:00:00Z", { label: "redraft" })]);
    expect(ownerCallsWhileOpen(a, [a, b, c], OWNER, null)).toBe(1);
    expect(ownerCallsWhileOpen(a, [a, b, c], OWNER, "2026-07-04T00:00:00Z")).toBe(0);
  });
});

describe("hand labels and validation", () => {
  it("stamps hand labels human / hand-label", () => {
    expect(handLabel({ id: `${REPO}#7`, label: "approve", labeled_at: "2026-09-23T00:00:00Z", labeler: "owner" }, null)).toMatchObject({
      repo: REPO,
      number: 7,
      label_provenance: "human",
      label_source: "hand-label",
      unambiguous: true,
    });
  });

  it("refuses rows without a valid label, provenance or ambiguity flag, naming the row", () => {
    const good = { id: `${REPO}#1`, label: "approve", label_provenance: "human", unambiguous: true };
    expect(validateLabel(good, "x")).toBe(good);
    expect(() => validateLabel({ ...good, label: "yes" }, "row 3")).toThrow(/row 3/);
    expect(() => validateLabel({ ...good, label_provenance: undefined }, "x")).toThrow(/provenance/);
    expect(() => validateLabel({ ...good, label_provenance: "llm" }, "labels.jsonl row 7")).toThrow(/labels\.jsonl row 7.*non-human labels are refused/);
    expect(() => validateLabel({ ...good, unambiguous: undefined }, "x")).toThrow(/unambiguous/);
  });
});

describe("the committed golden set", () => {
  const proposals = readRows("data/judge/proposals.jsonl");
  const labels = readRows("data/judge/labels-github.jsonl");

  it("re-deriving the labels from the committed record reproduces the committed labels exactly", () => {
    const histories = readRows("data/judge/github-events.jsonl") as RecordedIssue[];
    const baseline = proposals[0].repo;
    const prs = (readRows("data/judge/pull-requests.jsonl") as RecordedPr[]).filter((p) => p.repo === baseline);
    const owner = baseline.split("/")[0];
    const derived = histories
      .map((h) => deriveGithubLabel(h, prs, owner, ownerCallsWhileOpen(h, histories, owner, (h as RecordedIssue & { closed_at?: string | null }).closed_at ?? null)))
      .sort((a, b) => a.number - b.number);
    expect(derived).toEqual(labels);
  });

  it("gives the judge no labels: the inputs carry only id, repo, number, url, date, title and body", () => {
    for (const p of proposals) expect(Object.keys(p).sort()).toEqual(["body", "filed_at", "id", "number", "repo", "title", "url"]);
  });

  it("labels every proposal once, all human-made, with the passed-over ones marked ambiguous", () => {
    expect(new Set(labels.map((l) => l.id))).toEqual(new Set(proposals.map((p) => p.id)));
    for (const l of labels) {
      expect(l.label_provenance).toBe("human");
      expect(l.unambiguous).toBe(l.label_kind !== "passed-over" && l.label_kind !== "closed-not-planned" && l.label_kind !== "build-closed");
    }
  });

  it("is not the LLM-labelled duplicate-detection set", () => {
    const files = ["data/judge/proposals.jsonl", "data/judge/labels-github.jsonl"].map((f) => readFileSync(join(ROOT, f), "utf8"));
    for (const f of files) expect(f).not.toContain("gold-pairs");
  });
});

describe("one definition of the loop's identity", () => {
  it("the harness's copies match the template's", () => {
    expect(MERGE_RATE_PATTERNS).toEqual(TEMPLATE_PATTERNS);
    const golden = readFileSync(join(ROOT, "lib/judge/golden.ts"), "utf8");
    expect(golden).toContain(`const LOOP_AUTHOR_PATTERNS = ${JSON.stringify(TEMPLATE_PATTERNS).replace(/,/g, ", ")};`);
  });
});
