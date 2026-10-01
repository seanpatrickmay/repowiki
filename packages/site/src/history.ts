import type { Revision } from "@repowiki/core";
import { type ArticleView, articleView } from "./article.ts";
import { formatDate, formatNumber, shortSha } from "./format.ts";
import { escapeHtml } from "./inline.ts";
import { hasArticleRoute, type SiteModel } from "./model.ts";
import { articleUrl, historyUrl, oldRevisionUrl } from "./urls.ts";

export interface HistoryRow {
  n: number;
  date: string;
  oldHref: string;
  /** Trusted HTML: "update (PR #88)" with links when the repo URL is known. */
  summaryHtml: string;
  /** Trusted HTML: the short sha, linked to the commit when the repo URL is known. */
  commitHtml: string;
  /** Plain text. */
  cost: string;
}

/** True when /wiki/<id>/history/ exists: the feature has revisions and a page to go back to. */
export function hasHistory(site: SiteModel, id: string): boolean {
  return (site.history.get(id)?.length ?? 0) > 0 && hasArticleRoute(site, id);
}

/** The "View history" link for /wiki/<slug>/, or null when there is no history page to link. */
export function historyHref(site: SiteModel, slug: string): string | null {
  return hasHistory(site, slug) ? historyUrl(slug) : null;
}

/** "View history" rows, newest first. Dates are commit dates (spec §5 rule 5). */
export function historyRows(site: SiteModel, featureId: string): HistoryRow[] {
  const revisions = site.history.get(featureId) ?? [];
  return revisions
    .map((revision, index) => {
      const n = index + 1;
      return {
        n,
        date: formatDate(revision.commitDate),
        oldHref: oldRevisionUrl(featureId, n),
        summaryHtml: summaryHtml(site, revision),
        commitHtml: commitHtml(site, revision),
        cost: `${revision.model}, ${formatNumber(revision.tokens.in)} in / ${formatNumber(revision.tokens.out)} out tokens`,
      };
    })
    .reverse();
}

export interface HistoryPage {
  /** Plain text. */
  title: string;
  rows: HistoryRow[];
}

/** Everything /wiki/<id>/history/ prints. */
export function historyPage(site: SiteModel, featureId: string): HistoryPage {
  return {
    title: site.features.get(featureId)?.title ?? featureId,
    rows: historyRows(site, featureId),
  };
}

/** One page per revision of every feature that has a history page. n is 1-based, oldest first. */
export function oldRevisionRoutes(site: SiteModel): { featureId: string; n: number }[] {
  return [...site.history.entries()].flatMap(([featureId, revisions]) =>
    hasHistory(site, featureId) ? revisions.map((_, index) => ({ featureId, n: index + 1 })) : [],
  );
}

/** The article view of revision n of a feature, under the old-revision notice. */
export function oldRevisionView(site: SiteModel, featureId: string, n: number): ArticleView {
  const revision = site.history.get(featureId)?.[n - 1];
  if (revision === undefined) throw new Error(`no revision ${n} of ${featureId}`);
  return { ...articleView(site, revision), notice: oldRevisionNotice(site, revision) };
}

function commitHtml(site: SiteModel, revision: Revision): string {
  const sha = `<code>${shortSha(revision.sha)}</code>`;
  return site.repoUrl === null
    ? sha
    : `<a class="external" href="${escapeHtml(`${site.repoUrl}/commit/${revision.sha}`)}">${sha}</a>`;
}

function summaryHtml(site: SiteModel, revision: Revision): string {
  const reason = escapeHtml(revision.reason);
  if (revision.pr === null) return reason;
  const pr =
    site.repoUrl === null
      ? `PR #${revision.pr}`
      : `<a class="external" href="${escapeHtml(`${site.repoUrl}/pull/${revision.pr}`)}">PR #${revision.pr}</a>`;
  return `${reason} (${pr})`;
}

/** Banner for /wiki/<id>/history/<n>/. Trusted HTML. */
export function oldRevisionNotice(site: SiteModel, revision: Revision): string {
  const current = site.pages.get(revision.featureId)?.id === revision.id;
  const when = `as of ${formatDate(revision.commitDate)} (commit ${commitHtml(site, revision)})`;
  return current
    ? `This is the current revision of this page, ${when}.`
    : `This is an old revision of this page, ${when}. It may differ significantly from the <a href="${articleUrl(revision.featureId)}">current revision</a>.`;
}
