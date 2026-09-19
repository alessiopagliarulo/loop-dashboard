/**
 * "Already covered" — the flag the loop puts on an idea that existing work already
 * seems to do.
 *
 * The owner does not only work through the loop's queue: they build things by hand,
 * push branches, open draft PRs. The Scout, Redraft and Builder workflows now read all
 * of that (`scripts/loop-inflight.mjs` in the target repo, from
 * config/loop-template/files/loop-inflight.mjs) and, when an idea turns out to be
 * covered by an open PR, a pushed branch, a recent merge or another idea, they add
 * the `covered` label and post a comment whose first line is {@link COVERED_MARKER},
 * followed by one `- [what it is](url)` bullet per covering item.
 *
 * This module is the dashboard's half of that contract: it reads the links back out
 * of the latest such comment so the Ideas card can show them without anyone opening
 * the thread. Pure functions only; `lib/queues.ts` does the fetching. The constants
 * are pinned to the template script's own by tests/lib/loop-inflight.test.ts.
 */

/** The flag. Not a queue state — a warning worn on top of one, like `stale`. */
export const COVERED_LABEL = "covered";

/** First line of every "covered" comment, whoever wrote it (script or agent). */
export const COVERED_MARKER = "<!-- loop:covered -->";

/** One thing that covers an idea, as the comment named it. */
export type CoverLink = {
  /** What it is, in the comment's words ("open draft PR #30: …"). */
  text: string;
  url: string;
};

/** A comment as far as this module cares. */
export type CoverSourceComment = { body: string; createdAt: string };

/** At most this many links are shown; the comment itself has the rest. */
const MAX_LINKS = 5;

/**
 * The covering links in one comment, or `null` when it is not a covered comment.
 *
 * Only links into the idea's OWN repository are kept. The comment may have been
 * written by a model reading third-party text, and a card that renders whatever URL
 * it was handed would be a phishing surface; every legitimate cover — a PR, a
 * branch comparison, a commit, another issue — lives in the same repo anyway.
 */
export function parseCoverComment(
  body: string,
  repo: { owner: string; repo: string },
): CoverLink[] | null {
  if (!body.includes(COVERED_MARKER)) return null;
  const prefix = `https://github.com/${repo.owner}/${repo.repo}/`.toLowerCase();
  const links: CoverLink[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/\[([^\]\n]{1,300})\]\((https:\/\/[^)\s]+)\)/g)) {
    const text = m[1].trim();
    const url = m[2];
    if (!url.toLowerCase().startsWith(prefix) || seen.has(url)) continue;
    seen.add(url);
    links.push({ text, url });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

/**
 * The links from the NEWEST covered comment on a thread, or `null` if the thread has
 * none. Newest wins because a later check (say, after a redraft) describes the idea
 * as it stands now.
 */
export function latestCoverLinks(
  comments: CoverSourceComment[],
  repo: { owner: string; repo: string },
): CoverLink[] | null {
  const newestFirst = [...comments].sort(
    (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
  );
  for (const c of newestFirst) {
    const links = parseCoverComment(c.body ?? "", repo);
    if (links) return links;
  }
  return null;
}
