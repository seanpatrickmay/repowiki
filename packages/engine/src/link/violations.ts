import { type Architecture, linkRoutes, type Manifest, type Revision } from "@repowiki/core";
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

/**
 * How many [[id]] links and See also entries of `revisions` (the current pages) name an active
 * feature that has no page among them, such as one whose page failed to write. Not a violation:
 * the site shows such a link as plain text (spec §7.3's stored-page rule, reported only).
 */
export function linksWithoutPage(revisions: readonly Revision[], manifest: Manifest): number {
  const active = new Set(
    manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id),
  );
  const written = new Set(revisions.map((r) => r.featureId));
  const missing = (id: string) => active.has(id) && !written.has(id);
  let count = 0;
  for (const revision of revisions) {
    count += revision.seeAlso.filter(missing).length;
    for (const section of revision.sections) {
      for (const claim of section.claims) {
        count += linkTokensIn(claim.text).filter(({ target }) => missing(target)).length;
      }
    }
  }
  return count;
}

/**
 * linkViolations for the project's article (the Architecture article, F27): every [[id]] token
 * must name an active page, and every page a claim names as its support must be an active
 * feature. An active feature with no stored page is not a violation; it is counted by
 * architectureLinksWithoutPage, as the pages' own are by linksWithoutPage.
 */
export function architectureLinkViolations(article: Architecture, manifest: Manifest): string[] {
  const active = new Set(
    manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id),
  );
  const problems: string[] = [];
  for (const section of article.sections) {
    for (const claim of section.claims) {
      for (const problem of textLinkViolations(claim.text, manifest)) {
        problems.push(`architecture ${quote(claim.id)}: ${problem}`);
      }
      for (const id of claim.pages) {
        if (!active.has(id)) {
          problems.push(
            `architecture ${quote(claim.id)}: names ${quote(id)}, which is not an active feature`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * linksWithoutPage for the project's article: how many [[id]] links and named pages of its claims
 * name an active feature that is not in `pages`, the features with a current page. Not a
 * violation: the site shows such a link as plain text (reported only).
 */
export function architectureLinksWithoutPage(
  article: Architecture,
  manifest: Manifest,
  pages: ReadonlySet<string>,
): number {
  const active = new Set(
    manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id),
  );
  const missing = (id: string) => active.has(id) && !pages.has(id);
  let count = 0;
  for (const section of article.sections) {
    for (const claim of section.claims) {
      count += linkTokensIn(claim.text).filter(({ target }) => missing(target)).length;
      count += claim.pages.filter(missing).length;
    }
  }
  return count;
}

/** linkRoutes, under the name this module's checks were written with. */
const routingIn = linkRoutes;

/** The distinct ids of the [[id]] links in a text that point inside the wiki (not `wp:`). */
function wikiTargetsIn(text: string): string[] {
  const targets = linkTokensIn(text)
    .map(({ target }) => target)
    .filter((target) => !target.startsWith("wp:"));
  return [...new Set(targets)];
}

/**
 * linkViolations for a stored revision, which may be older than the latest manifest (an update
 * carries a page forward, and a later merge can turn one of its [[id]] links into a redirect):
 * its links are judged against `own`, the manifest at the revision's sha, as the linker wrote
 * them, and each link that was valid there must still route today in `latest` (see routingIn).
 * A link that was never valid is reported once, by linkViolations, and not again here.
 */
export function storedLinkViolations(
  revision: Revision,
  own: Manifest,
  latest: Manifest,
  pages: ReadonlySet<string>,
): string[] {
  const routes = routingIn(latest, pages);
  const ownKind = new Map(own.features.map((f) => [f.id, f.status.kind]));
  const problems = linkViolations(revision, own);
  for (const id of revision.seeAlso) {
    if (ownKind.get(id) === "active" && id !== revision.featureId && !routes(id)) {
      problems.push(
        `${revision.featureId}: See also lists ${quote(id)}, which no longer leads to a page`,
      );
    }
  }
  for (const section of revision.sections) {
    for (const claim of section.claims) {
      for (const id of wikiTargetsIn(claim.text)) {
        const kind = ownKind.get(id);
        if ((kind === "active" || kind === "disambiguation") && !routes(id)) {
          problems.push(
            `${revision.featureId} ${quote(claim.id)}: a link to ${quote(id)} no longer leads to a page`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * architectureLinkViolations for a stored article, which may be older than the latest manifest:
 * judged against `own` (the manifest at its sha), and each [[id]] link and named page that was
 * valid there must still route today in `latest` (see routingIn). Like storedLinkViolations, it
 * counts an active feature with no page as routing (architectureLinksWithoutPage reports it) and
 * reports a retired one with no page, or one `latest` no longer holds, as a problem.
 */
export function storedArchitectureLinkViolations(
  article: Architecture,
  own: Manifest,
  latest: Manifest,
  pages: ReadonlySet<string>,
): string[] {
  const routes = routingIn(latest, pages);
  const ownKind = new Map(own.features.map((f) => [f.id, f.status.kind]));
  const problems = architectureLinkViolations(article, own);
  for (const section of article.sections) {
    for (const claim of section.claims) {
      for (const id of wikiTargetsIn(claim.text)) {
        const kind = ownKind.get(id);
        if ((kind === "active" || kind === "disambiguation") && !routes(id)) {
          problems.push(
            `architecture ${quote(claim.id)}: a link to ${quote(id)} no longer leads to a page`,
          );
        }
      }
      for (const id of claim.pages) {
        if (ownKind.get(id) === "active" && !routes(id)) {
          problems.push(
            `architecture ${quote(claim.id)}: names ${quote(id)}, which no longer leads to a page`,
          );
        }
      }
    }
  }
  return problems;
}
