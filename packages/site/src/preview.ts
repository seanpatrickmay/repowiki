import { formatDate, formatNumber } from "./format.ts";
import { escapeHtml } from "./inline.ts";
import { featureLink, finalTarget, hasArticleRoute, type SiteModel } from "./model.ts";
import { leadSummary } from "./summary.ts";
import { articleUrl } from "./urls.ts";

/** Body of /api/preview/<id>.json, shown when a reader hovers or focuses a link to <id>. */
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
export function articleLink(
  site: SiteModel,
  id: string,
): { href: string; title: string; preview: boolean } | null {
  const link = featureLink(site, id);
  return link === null ? null : { ...link, preview: previewData(site, id) !== null };
}
