import type { Claim, Manifest, Revision } from "@repowiki/core";

/** The commits a claim cites. */
export const commitsOf = (claim: Claim): Set<string> =>
  new Set(claim.citations.flatMap((c) => (c.kind === "commit" ? [c.sha] : [])));

/** Whether `by` holds every one of `commits`, and there is one at least. */
export const coversCommits = (by: ReadonlySet<string>, commits: ReadonlySet<string>): boolean =>
  commits.size > 0 && [...commits].every((sha) => by.has(sha));

const historyOf = (page: Revision | null): Claim[] =>
  page?.sections.find((s) => s.key === "history")?.claims ?? [];

/**
 * The History claims a whole write of `featureId` carries forward, as stored (spec §5 rule 4,
 * §6.3; commit citations never go stale): every one of its own current page `own`, then those of
 * each page merged into it, by feature id. A page whose every merge into it `own` already
 * contains (`contains(mergeSha)`) should already be in `own`'s History, so only its claims whose
 * commits no claim of `own` all cites are carried: a claim carried before is not carried twice,
 * and one a fill-in build never carried (#357) is.
 */
export function carriedHistory(
  manifest: Manifest,
  featureId: string,
  own: Revision | null,
  pageOf: (featureId: string) => Revision | null,
  contains: (mergeSha: string) => boolean,
): Claim[] {
  const kept = historyOf(own);
  const cited = kept.map(commitsOf);
  const merged = new Map<string, boolean>();
  for (const feature of manifest.features) {
    if (feature.status.kind !== "redirect" || feature.status.to !== featureId) continue;
    for (const event of feature.lineage) {
      if (event.kind !== "merge" || event.into !== featureId) continue;
      const contained = own !== null && contains(event.sha);
      merged.set(feature.id, (merged.get(feature.id) ?? true) && contained);
    }
  }
  const carried = [...merged.keys()].sort().flatMap((id) => {
    const claims = historyOf(pageOf(id));
    if (!merged.get(id)) return claims;
    return claims.filter((claim) => !cited.some((by) => coversCommits(by, commitsOf(claim))));
  });
  return [...kept, ...carried];
}
