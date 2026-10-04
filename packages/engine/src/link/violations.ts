import type { Manifest, Revision } from "@repowiki/core";
import { quote } from "../verify/index.ts";
import { linkTokensIn } from "./links.ts";

/**
 * Every [[id]] token in a text, read the way the site reads it, that names no active page: an id
 * outside the manifest, or a retired feature or a redirect (the linker always writes the final
 * target, so a redirect id is never its output). A disambiguation page is a page.
 */
export function textLinkViolations(text: string, manifest: Manifest): string[] {
  const byId = new Map(manifest.features.map((f) => [f.id, f]));
  const problems: string[] = [];
  for (const { target } of linkTokensIn(text)) {
    if (target.startsWith("wp:")) continue;
    const kind = byId.get(target)?.status.kind;
    if (kind === undefined) problems.push(`a link to ${quote(target)} is not a feature id`);
    else if (kind === "retired" || kind === "redirect") {
      problems.push(`a link to ${quote(target)} is not an active feature id`);
    }
  }
  return problems;
}

/**
 * Every link in a revision that would point nowhere (spec §8: "no links to nonexistent IDs"):
 * a See also id that is not an active feature of the manifest, or the page itself, and a
 * [[id]] token whose id is not an active feature (or disambiguation page) of the manifest. Tokens
 * are read the way the site reads them, so a crafted target (a path, a URL, a nested bracket) is
 * reported, not rendered. Empty for every revision the linker wrote. Targets and ids are model
 * strings, so the messages quote them (see `quote`).
 */
export function linkViolations(revision: Revision, manifest: Manifest): string[] {
  const byId = new Map(manifest.features.map((f) => [f.id, f]));
  const problems: string[] = [];
  for (const id of revision.seeAlso) {
    if (byId.get(id)?.status.kind !== "active" || id === revision.featureId) {
      problems.push(`${revision.featureId}: See also lists ${quote(id)}, which has no page`);
    }
  }
  for (const section of revision.sections) {
    for (const claim of section.claims) {
      for (const problem of textLinkViolations(claim.text, manifest)) {
        problems.push(`${revision.featureId} ${quote(claim.id)}: ${problem}`);
      }
    }
  }
  return problems;
}
