import type { Manifest, Revision } from "@repowiki/core";
import { linkTokensIn } from "./links.ts";

/**
 * Every link in a revision that would point nowhere (spec §8: "no links to nonexistent IDs"):
 * a See also id that is not an active feature of the manifest, or the page itself, and a
 * [[id]] token whose id is not a manifest feature. Tokens are read the way the site reads them,
 * so a crafted target (a path, a URL, a nested bracket) is reported, not rendered. Empty for
 * every revision the linker wrote.
 */
export function linkViolations(revision: Revision, manifest: Manifest): string[] {
  const byId = new Map(manifest.features.map((f) => [f.id, f]));
  const problems: string[] = [];
  for (const id of revision.seeAlso) {
    if (byId.get(id)?.status.kind !== "active" || id === revision.featureId) {
      problems.push(`${revision.featureId}: See also lists ${id}, which has no page`);
    }
  }
  for (const section of revision.sections) {
    for (const claim of section.claims) {
      for (const { target } of linkTokensIn(claim.text)) {
        if (!target.startsWith("wp:") && !byId.has(target)) {
          problems.push(`${revision.featureId} ${claim.id}: [[${target}]] is not a feature id`);
        }
      }
    }
  }
  return problems;
}
