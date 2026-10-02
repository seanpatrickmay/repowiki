import type { Revision } from "@repowiki/core";
import { type ArticleView, articleView } from "./article.ts";
import { featureLink, finalTarget, type SiteModel } from "./model.ts";
import { leadSummary } from "./summary.ts";

type ArticleRoute = { slug: string; kind: "article"; featureId: string };

/** One page under /wiki/<slug>/. Redirects and disambiguations come from features or aliases. */
export type WikiRoute =
  | ArticleRoute
  | { slug: string; kind: "redirect"; title: string; target: string }
  | { slug: string; kind: "disambiguation"; title: string; targets: string[] };

/**
 * Every /wiki/<slug>/ page: articles for active and retired features that have a revision,
 * a redirect or disambiguation page per feature status, then one page per alias slug.
 */
export function wikiRoutes(site: SiteModel): WikiRoute[] {
  const routes: WikiRoute[] = [];
  for (const feature of site.wiki.manifest.features) {
    const { id, title, status } = feature;
    if (status.kind === "redirect") {
      routes.push({ slug: id, kind: "redirect", title, target: finalTarget(site, id) });
    } else if (status.kind === "disambiguation") {
      routes.push({ slug: id, kind: "disambiguation", title, targets: status.to });
    } else if (site.pages.has(id)) {
      routes.push({ slug: id, kind: "article", featureId: id });
    }
  }
  for (const alias of site.aliases) {
    const [only, ...more] = alias.targets;
    if (only === undefined) continue;
    routes.push(
      more.length === 0
        ? { slug: alias.slug, kind: "redirect", title: alias.alias, target: only }
        : { slug: alias.slug, kind: "disambiguation", title: alias.alias, targets: alias.targets },
    );
  }
  return routes;
}

/** The current revision an article route renders. A route without a page is a build bug. */
export function articleFor(site: SiteModel, route: ArticleRoute): Revision {
  const page = site.pages.get(route.featureId);
  if (page === undefined) throw new Error(`no page for ${route.featureId}`);
  return page;
}

/** Everything a /wiki/<slug>/ template prints. Same plain-text / trusted-HTML rule as ArticleView. */
export type PageView =
  | {
      kind: "article";
      view: ArticleView;
      /** True for an active feature's current article; retired articles stay out of search. */
      indexed: boolean;
    }
  | {
      kind: "redirect";
      /** Plain text. */
      title: string;
      /** Plain text title; `href` is null when the target has no page. */
      target: { title: string; href: string | null };
      /** The `content` of the meta refresh tag, or null when there is nowhere to go. */
      refresh: string | null;
    }
  | {
      kind: "disambiguation";
      /** Plain text. */
      title: string;
      entries: {
        /** Plain text. */
        title: string;
        href: string | null;
        /** Trusted HTML: ": " plus the target's link-free lead, or null when it has no page. */
        summaryHtml: string | null;
      }[];
    };

export function pageFor(site: SiteModel, route: WikiRoute): PageView {
  const titleOf = (id: string) => site.features.get(id)?.title ?? id;
  switch (route.kind) {
    case "article":
      return {
        kind: "article",
        view: articleView(site, articleFor(site, route)),
        indexed: site.features.get(route.featureId)?.status.kind === "active",
      };
    case "redirect": {
      const link = featureLink(site, route.target);
      // A lone surrogate would make encodeURIComponent throw.
      const from = encodeURIComponent(route.title.toWellFormed());
      return {
        kind: "redirect",
        title: route.title,
        target: { title: link?.title ?? titleOf(route.target), href: link?.href ?? null },
        refresh: link === null ? null : `0; url=${link.href}?redirectedfrom=${from}`,
      };
    }
    case "disambiguation": {
      // A merged-away target shows its final article, not its own stale lead; two targets that
      // merge into one article list it once.
      const ids = [...new Set(route.targets.map((id) => finalTarget(site, id)))];
      return {
        kind: "disambiguation",
        title: route.title,
        entries: ids.map((id) => {
          const summary = leadSummary(site, id);
          return {
            title: titleOf(id),
            href: featureLink(site, id)?.href ?? null,
            summaryHtml: summary === null ? null : `: ${summary}`,
          };
        }),
      };
    }
  }
}
