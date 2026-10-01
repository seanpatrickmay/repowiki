import type { Revision } from "@repowiki/core";
import type { SiteModel } from "./model.ts";

/** One page under /wiki/<slug>/. */
export type WikiRoute = { slug: string; kind: "article"; featureId: string };

/** Every /wiki/<slug>/ page: articles for active and retired features that have a revision. */
export function wikiRoutes(site: SiteModel): WikiRoute[] {
  const routes: WikiRoute[] = [];
  for (const feature of site.wiki.manifest.features) {
    const kind = feature.status.kind;
    if ((kind === "active" || kind === "retired") && site.pages.has(feature.id)) {
      routes.push({ slug: feature.id, kind: "article", featureId: feature.id });
    }
  }
  return routes;
}

/** The current revision an article route renders. A route without a page is a build bug. */
export function articleFor(site: SiteModel, route: WikiRoute): Revision {
  const page = site.pages.get(route.featureId);
  if (page === undefined) throw new Error(`no page for ${route.featureId}`);
  return page;
}
