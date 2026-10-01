import {
  FEATURE_ID_MAX_LENGTH,
  type Feature,
  type Revision,
  type WikiExport,
} from "@repowiki/core";
import { articleUrl } from "./urls.ts";

/** An alias URL /wiki/<slug>/: a redirect when it has one target, a disambiguation page otherwise. */
export interface AliasRoute {
  slug: string;
  /** The first spelling that produced this slug. */
  alias: string;
  /** Feature ids, already resolved through redirects, in manifest order. */
  targets: string[];
}

export interface SiteModel {
  wiki: WikiExport;
  repoUrl: string | null;
  features: ReadonlyMap<string, Feature>;
  /** Current revision per feature id. */
  pages: ReadonlyMap<string, Revision>;
  /** Every revision per feature id, oldest first. */
  history: ReadonlyMap<string, readonly Revision[]>;
  /** Sorted by slug. Never shadows a feature id. */
  aliases: readonly AliasRoute[];
}

/** URL slug for an alias: ASCII lowercase kebab-case, at most FEATURE_ID_MAX_LENGTH characters. */
export function aliasSlug(alias: string): string {
  return alias
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FEATURE_ID_MAX_LENGTH)
    .replace(/-+$/, "");
}

/** True when /wiki/<id>/ is a page: an active or retired feature that has a revision. */
export function hasArticleRoute(site: SiteModel, id: string): boolean {
  const kind = site.features.get(id)?.status.kind;
  return (kind === "active" || kind === "retired") && site.pages.has(id);
}

/** Follows redirects to the feature a reader should land on. The manifest forbids cycles. */
export function finalTarget(site: SiteModel, id: string): string {
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    const status = site.features.get(current)?.status;
    if (status?.kind !== "redirect" || seen.has(current)) return current;
    seen.add(current);
    current = status.to;
  }
}

/** Link target for [[id]] tokens and See also entries, or null when the id has no page. */
export function featureLink(site: SiteModel, id: string): { href: string; title: string } | null {
  const feature = site.features.get(id);
  if (feature === undefined || !hasArticleRoute(site, id)) return null;
  return { href: articleUrl(id), title: feature.title };
}

export function buildSiteModel(wiki: WikiExport, repoUrl: string | null): SiteModel {
  const site: SiteModel = {
    wiki,
    repoUrl,
    features: new Map(wiki.manifest.features.map((feature) => [feature.id, feature])),
    pages: new Map(wiki.pages.map((page) => [page.featureId, page])),
    history: new Map(Object.entries(wiki.history)),
    aliases: [],
  };

  const routes = new Map<string, AliasRoute>();
  for (const feature of wiki.manifest.features) {
    if (!hasArticleRoute(site, feature.id)) continue;
    const target = finalTarget(site, feature.id);
    for (const alias of feature.aliases) {
      const slug = aliasSlug(alias);
      if (slug === "" || site.features.has(slug)) continue;
      const route = routes.get(slug) ?? { slug, alias, targets: [] };
      if (!route.targets.includes(target)) route.targets.push(target);
      routes.set(slug, route);
    }
  }
  site.aliases = [...routes.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return site;
}
