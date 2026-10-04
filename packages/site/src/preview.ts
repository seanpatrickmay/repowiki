import { createHash } from "node:crypto";
import { formatDate, formatNumber } from "./format.ts";
import { escapeHtml, type InlineOptions } from "./inline.ts";
import { featureLink, finalTarget, hasArticleRoute, type SiteModel } from "./model.ts";
import { leadSummary } from "./summary.ts";
import { articleUrl } from "./urls.ts";

/** Body of /api/preview/<id>.json and /api/preview/wp/<hash>.json, shown when a reader hovers or focuses a link to <id>. */
export interface Preview {
  /** Plain text: the client inserts it with textContent. */
  title: string;
  url: string;
  /** Escaped at build time; the client inserts it as-is. */
  html: string;
}

const previews = new WeakMap<SiteModel, Map<string, Preview | null>>();

/**
 * Preview for a link target. Redirects preview their final target; null when there is none.
 * Memoized per site and id: every link on every page asks, and each answer renders a lead.
 */
export function previewData(site: SiteModel, id: string): Preview | null {
  let byId = previews.get(site);
  if (byId === undefined) {
    byId = new Map();
    previews.set(site, byId);
  }
  if (byId.has(id)) return byId.get(id) ?? null;
  const preview = computePreview(site, id);
  byId.set(id, preview);
  return preview;
}

function computePreview(site: SiteModel, id: string): Preview | null {
  if (!hasArticleRoute(site, id)) return null;
  const targetId = finalTarget(site, id);
  const feature = site.features.get(targetId);
  if (feature === undefined) return null;
  const url = articleUrl(targetId);

  if (feature.status.kind === "disambiguation") {
    const names = feature.status.to.map((to) => escapeHtml(site.features.get(to)?.title ?? to));
    const html = `<p><b>${escapeHtml(feature.title)}</b> may refer to: ${names.join(", ")}.</p>`;
    return { title: feature.title, url, html };
  }

  const page = site.pages.get(targetId);
  const lead = leadSummary(site, targetId);
  if (page === undefined || lead === null) return null;
  const box = page.infobox;
  const facts = [
    `${formatNumber(box.files)} files`,
    `${formatNumber(box.loc)} lines`,
    ...(box.languages.length > 0 ? [box.languages.map(escapeHtml).join(", ")] : []),
    `last commit ${formatDate(box.lastCommitDate)}`,
  ];
  const html = `<p>${lead}</p><p class="preview-facts">${facts.join(" &middot; ")}</p>`;
  return { title: feature.title, url, html };
}

/** Link target for a [[id]] token in an article; it asks for a hover preview only if one is served. */
function articleLink(
  site: SiteModel,
  id: string,
): { href: string; title: string; preview: boolean } | null {
  const link = featureLink(site, id);
  return link === null ? null : { ...link, preview: previewData(site, id) !== null };
}

/**
 * Wikipedia's form of a title for comparing: spaces for underscores, whitespace runs collapsed,
 * the first letter upper case. The same rule as the engine's link module, which keys the
 * export's `wikipedia` map; the site depends on core only, so it is repeated here.
 */
function normalizeWikipediaTitle(title: string): string {
  const spaced = title.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return spaced === "" ? "" : `${spaced[0]?.toUpperCase()}${spaced.slice(1)}`;
}

/** File name of a title's preview: titles hold any character, so the name is a hash, never the title. */
const wikipediaHash = (title: string): string =>
  createHash("sha256")
    .update(normalizeWikipediaTitle(title).toWellFormed(), "utf8")
    .digest("hex")
    .slice(0, 32);

const wikipediaByHash = new WeakMap<SiteModel, Map<string, Preview>>();

/**
 * One preview per Wikipedia article in the export, by the hash of its normalized title. The
 * summary came from the network, so its text is escaped like any other preview's; the title is
 * plain text for the client's textContent. Built before any link asks, from the export alone: the
 * browser never contacts Wikipedia. A summary without text has no preview.
 */
export function wikipediaPreviews(site: SiteModel): ReadonlyMap<string, Preview> {
  let byHash = wikipediaByHash.get(site);
  if (byHash === undefined) {
    byHash = new Map();
    for (const [title, summary] of Object.entries(site.wiki.wikipedia)) {
      const hash = wikipediaHash(title);
      if (summary.extract.trim() === "" || byHash.has(hash)) continue;
      byHash.set(hash, {
        title: summary.title,
        url: summary.url,
        html: `<p>${escapeHtml(summary.extract)}</p><p class="preview-facts">From Wikipedia</p>`,
      });
    }
    wikipediaByHash.set(site, byHash);
  }
  return byHash;
}

/** The data-preview value of a [[wp:Title]] link ("wp:" and the hash), or null without a preview. */
function wikipediaPreviewId(site: SiteModel, title: string): string | null {
  const hash = wikipediaHash(title);
  return wikipediaPreviews(site).has(hash) ? `wp:${hash}` : null;
}

/** Link options for rendering claim text on a page: feature links and Wikipedia links both ask for previews. */
export function inlineOptions(site: SiteModel): InlineOptions {
  return {
    link: (id) => articleLink(site, id),
    wikipedia: (title) => wikipediaPreviewId(site, title),
  };
}
