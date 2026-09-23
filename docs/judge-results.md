# Proposal judge: what was measured, and what it does not show

> The committed numbers live in `metrics/judge-eval.json` (judge vs the owner's calls) and
> `metrics/merge-rate.json` (agent PR merge rate). Both are written by scripts in `scripts/judge/`
> from files committed under `data/judge/`, and re-running them on unchanged inputs rewrites the
> same bytes. This page reads them; if the two ever disagree, the JSON wins. Design decision:
> `docs/design-decisions.md` #16. The judge itself: `config/loop-template/files/loop-judge.mjs`.

## What the judge is

An LLM that reads one Scout proposal **before any code is written** and predicts the owner's own
call on it: *approve it for building as written*, or *not now*. It holds the proposal to the bar
the Scout was already given in `claude-scout.yml` (a plain-English title, what and why, quoted
`path:line` evidence, where it checked the idea is not already built, an S/M/L estimate, a "how we'd
know it worked" line) and to no standard of its own.

It is opt-in (`judge.enabled` in `.github/loop-config.json`, off by default) and flag-only: one
comment, and on "not now" a `judge-hold` label that the Builder's autonomous self-pick respects.
It never closes, declines, approves or edits anything, and the owner approving a held idea
overrides the hold.

## The golden set, and where its labels come from

| | |
|---|---|
| Proposals | 52 Scout proposals from `alessiopagliarulo/content-generation-platform` (archived, so the record cannot change), filed 2026-07-14 to 2026-07-23 |
| Label provenance | **human, 52 of 52.** Each label is the owner's own recorded GitHub action, not something an LLM assigned |
| LLM-assigned labels | **none** |
| Hand labels | **none yet** (`data/judge/labels-hand.jsonl` does not exist) |
| Not this file | `data/gold-pairs-llm.jsonl`. That is a duplicate-detection set with LLM-assigned labels, it is not a proposal-judging set, and nothing here uses it |

The 52 labels split three ways, and the split is the most important fact on this page:

| Kind | n | The owner's call | How it was read |
|---|---|---|---|
| `approved` | 20 | approve | He put the `approved` label on it |
| `merged-build` | 9 | approve | Never labelled, but a build of it was merged |
| `passed-over` | 23 | not now | He never approved, built or declined it |

**There is no explicit "no" in the record.** The `declined` label was never used on this repo, so
all 23 negatives are silence: proposals he did not approve while he was approving others. Counting
that as "not now" is an assumption, and it is the weakest part of this measurement. It is also
confounded with time: all 23 of the earliest proposals were approved, and 23 of the 29 filed from
2026-07-20 on were passed over, so "passed over" partly reflects when triage tailed off
(`docs/ml-results.md` finds the same stall) and not only his view of the idea. Every figure
below is therefore reported with and without that assumption, and by label kind, never as one
number.

The recorded history was read only from the archived baseline repo. On the current target
(`supply-chain-optimizer`), automated workers also acted under the owner's account, so its record
cannot show that a person made a call; it is used for merge-rate counts only.

## Result: judge vs the owner's recorded calls

One live run, `sonnet` (resolved to `claude-sonnet-5`), prompt v1, Claude Code 2.1.280, on
2026-09-23, 52 calls, 0 failed, about $0.70 at list price. The judge saw each proposal's title and
body and nothing else; the labels are in other files the run script never opens. Its answers are
committed (`data/judge/verdicts/sonnet-prompt-v1.jsonl`), so everything below re-computes for free.

Label provenance for every row: **human (the owner's GitHub record).**

| Slice | n | Agreement | 95% interval | Always-say-the-majority baseline | Cohen's kappa |
|---|---|---|---|---|---|
| All recorded calls (passed-over counted as "not now") | 52 | 32/52 = **61.5%** | 48.1% to 75.0% | 55.8% (always "approve") | 0.22 (interval -0.05 to 0.48) |
| Explicit calls only (approvals) | 29 | 19/29 = 65.5% | 48.3% to 82.8% | 100% (always "approve") | undefined, one class |
| Passed-over only | 23 | 13/23 = 56.5% | 34.8% to 78.3% | 100% (always "not now") | undefined, one class |
| Same period (filed on or after the first passed-over one) | 29 | 16/29 = 55.2% | 37.9% to 72.4% | 79.3% (always "not now") | 0.05 (interval -0.27 to 0.37) |

Intervals are 2,000-replicate bootstrap, seed 20260923. Confusion on all 52: both approve 19, both
"not now" 13, judge approve but owner passed over 10, judge "not now" but owner approved 10.

What this supports:

- **On this data the judge agrees with the owner on about 6 in 10 proposals.** That is only a little
  above always saying "approve" (55.8%), and the interval on the kappa includes zero. The measured
  signal is weak.
- **Its confidence score separates approvals from passed-over proposals only slightly** (ROC AUC
  0.66 overall, 0.55 in the same period). In the same-period slice, always answering "not now" would score 79.3%, well above
  the judge's 55.2%.
- **It holds 10 of the 29 proposals the owner approved.** Being flag-only, that costs a glance each
  and nothing else, which is why the gate is not allowed to act on its own.
- **It agrees best with builds that actually merged** (8 of 9), and about half the time with
  proposals he approved but that were not merged (11 of 20) or passed over (13 of 23).
- **Most proposals fall short of the Scout's own evidence line, in both groups.** By the judge's
  own read, only 31% of approved proposals and 26% of passed-over ones quote their `path:line`
  evidence, and 55% versus 39% show a check that the idea is not already built. That last item is
  the only one that differs much between the groups; the other items are met by nearly everything.
- **40.6% of the agreement (13 of 32) rests on the passed-over assumption.** If the owner would in
  fact have approved some passed-over proposals, each one the judge held turns from an agreement
  into a disagreement, so the true figure could be lower. Hand labels are how this gets settled.

What this does not support: any statement about a 150-example set (this one has 52), any judge-human
agreement near a round target, or any claim about explicit rejections (there are none in the
record). These are one model, one prompt, one run, one repo, one owner, over 52 proposals from ten
days in July 2026.

## Result: agent PR merge rate

`metrics/merge-rate.json` counts merged PRs over PRs from real GitHub data, recorded 2026-09-23. The
count depends on the rule, and no rule is the headline. On the archived baseline repo, which ran
before any judge existed:

| Rule | Count | Rate |
|---|---|---|
| PRs from a `claude/` branch opened by the loop's own identity (`claude[bot]`), open PRs counted as not merged | 20/47 | 42.6% |
| The same PRs, resolved ones only (merged over merged plus closed unmerged; 13 still open are left out) | 20/34 | 58.8% |
| Every PR from a `claude/` branch whoever opened it, open PRs counted as not merged | 22/49 | 44.9% |
| Loop PRs that build a Scout proposal, resolved only. The rule the post-gate figure uses | 19/29 | 65.5% |

Intervals for each are in the JSON. **The old "22 of 48" and "22 of 35" figures are not reproducible
from the recorded PRs under any of these rules.** The nearest is 22/49, which counts PRs the owner
opened himself; the old target repo is archived, so there is nothing left to re-count differently.
On the current target (`supply-chain-optimizer`) the loop has opened 2 PRs, both still open; none
of the loop's own PRs has merged.

### The post-gate merge rate is not measured

`post_gate` in the JSON is **n = 0, "not yet measured"**, and that is the state of the world, not a
placeholder. The gate ships off by default and has never run in front of a real build, so there is
no PR that was built from a proposal the judge scored first. Nothing here estimates, models or
extrapolates it, and no before/after improvement can be quoted. The harness is instrumented so it
accumulates from real runs: `scripts/judge/snapshot.mjs --fetch` records, for every loop PR, whether
the proposal it builds carried a judge verdict posted before the PR was opened, and
`scripts/judge/merge-rate.mjs` counts only those. It changes when an owner turns the gate on and the
Builder opens PRs after that.

## Not measured here

- **The judge's effect on the merge rate.** See above; it needs gated PRs over time.
- **Agreement with explicit rejections.** The record has none.
- **Agreement against hand labels.** None exist yet; the path for them is below.
- **Whether the code a proposal cites exists.** The judge sees the proposal text only, as the gate does.
- **Any other model, prompt or repo.** Change the prompt, schema or default model in
  `loop-judge.mjs`, bump `JUDGE_PROMPT_VERSION`, and re-measure; a test fails if the committed answers
  came from a different prompt than the template ships.

## Re-running it

```sh
node scripts/judge/evaluate.mjs      # judge vs owner, from committed files: free, deterministic
node scripts/judge/merge-rate.mjs    # merge-rate counts, from committed files: free, deterministic
node scripts/judge/snapshot.mjs --fetch   # re-record GitHub (read-only), then re-run the two above
node scripts/judge/run-judge.mjs     # dry run: prints what a live run would do, calls nothing
node scripts/judge/run-judge.mjs --live   # the only step that spends anything (one call per proposal)
```

The harness reads recorded data by default and never calls a model unless `--live` is passed.
`--live` skips proposals already answered, so an interrupted run resumes without paying twice.

### Hand-labelling (the owner, when he has the time)

```sh
node scripts/judge/label.mjs         # one keypress per proposal: a = approve, n = not now, s = skip
node scripts/judge/evaluate.mjs      # recomputes; hand labels appear as their own block
```

`label.mjs` asks, in a shuffled order, "Would you approve this for building, as written?", and never
shows the judge's answer or what the GitHub record says. It saves after every answer to
`data/judge/labels-hand.jsonl`, stamped human. `evaluate.mjs` scores those as their own label set,
never pooled with the GitHub record, and reports how often the two agree. It is the way to replace
the passed-over assumption with his real calls.
