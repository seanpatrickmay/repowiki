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
