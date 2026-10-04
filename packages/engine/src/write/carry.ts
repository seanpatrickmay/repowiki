import type { Claim, Manifest, Revision } from "@repowiki/core";
import type { CommitInfo } from "../index/index.ts";

/** The commits a claim cites. */
export const commitsOf = (claim: Claim): Set<string> =>
  new Set(claim.citations.flatMap((c) => (c.kind === "commit" ? [c.sha] : [])));

/** Whether `by` holds every one of `commits`, and there is one at least. */
export const coversCommits = (by: ReadonlySet<string>, commits: ReadonlySet<string>): boolean =>
  commits.size > 0 && [...commits].every((sha) => by.has(sha));

const historyOf = (page: Revision | null): Claim[] =>
  page?.sections.find((s) => s.key === "history")?.claims ?? [];

/**
 * Whether `history` (commits with their parents) reaches `ancestor` from `descendant`, itself
 * included. A descendant `history` does not hold contains nothing.
 */
function ancestry(history: readonly CommitInfo[]) {
  const parents = new Map(history.map((c) => [c.sha, c.parents]));
  const reached = new Map<string, Set<string>>();
  return (ancestor: string, descendant: string): boolean => {
    let seen = reached.get(descendant);
    if (seen === undefined) {
      seen = new Set();
      const queue = parents.has(descendant) ? [descendant] : [];
      for (let sha = queue.pop(); sha !== undefined; sha = queue.pop()) {
        if (seen.has(sha)) continue;
        seen.add(sha);
        queue.push(...(parents.get(sha) ?? []));
      }
      reached.set(descendant, seen);
    }
    return seen.has(ancestor);
  };
}

/** The features merged straight into `into`, by id, with the commits of those merges. */
function mergedInto(manifest: Manifest, into: string): { id: string; shas: string[] }[] {
  const merged = new Map<string, string[]>();
  for (const feature of manifest.features) {
    if (feature.status.kind !== "redirect" || feature.status.to !== into) continue;
    for (const event of feature.lineage) {
      if (event.kind === "merge" && event.into === into)
        merged.set(feature.id, [...(merged.get(feature.id) ?? []), event.sha]);
    }
  }
  return [...merged.keys()].sort().map((id) => ({ id, shas: merged.get(id) ?? [] }));
}

/**
 * The History claims a whole write of `featureId` carries forward, as stored (spec §5 rule 4,
 * §6.3; commit citations never go stale): every one of its own current page `own`, then those of
 * each page merged into it, by feature id, each followed by those of the pages merged into that
 * one, and so on: in a chain of merges one update made, no page in between was written to carry
 * them. Each feature is visited once, so a cycle in hostile lineage data ends the walk.
 *
 * A merged page whose every merge a page on its way to `featureId` (`own` included) already
 * contains, by `history` (every commit reachable from the wiki's sha), should already be in that
 * page's History, so only its claims whose commits no claim of those pages all cites are carried:
 * a claim carried before is not carried twice, and one a fill-in build never carried (#357) is.
 */
export function carriedHistory(
  manifest: Manifest,
  featureId: string,
  own: Revision | null,
  pageOf: (featureId: string) => Revision | null,
  history: readonly CommitInfo[],
): Claim[] {
  const contains = ancestry(history);
  const claims = [...historyOf(own)];
  const visited = new Set([featureId]);
  const walk = (into: string, path: readonly Revision[]): void => {
    const merged = mergedInto(manifest, into).filter(({ id }) => !visited.has(id));
    for (const { id } of merged) visited.add(id);
    for (const { id, shas } of merged) {
      const page = pageOf(id);
      const mine = historyOf(page);
      const contained = shas.every((sha) => path.some((p) => contains(sha, p.sha)));
      // Compared only with the claims of the pages on its way, never with another merged page's
      // (two pages' History often cite the same commit, as their first), and by commits only: a
      // code citation of a copy carried before may have been remapped by an update since.
      const cited = path.flatMap((p) => historyOf(p).map(commitsOf));
      claims.push(
        ...(contained
          ? mine.filter((claim) => !cited.some((by) => coversCommits(by, commitsOf(claim))))
          : mine),
      );
      walk(id, page === null ? path : [...path, page]);
    }
  };
  walk(featureId, own === null ? [] : [own]);
  return claims;
}
