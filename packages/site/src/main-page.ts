import type { Revision } from "@repowiki/core";
import { formatDate } from "./format.ts";
import { inflightStatus } from "./inflight.ts";
import { renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";
import { inlineOptions } from "./preview.ts";
import { leadSummary } from "./summary.ts";
import { architectureUrl, articleUrl, inProgressUrl, pullUrl } from "./urls.ts";

export const DID_YOU_KNOW_COUNT = 5;
export const RECENT_COUNT = 5;
/** Open pull requests the Main Page's In progress box lists. */
export const IN_PROGRESS_COUNT = 5;

export interface MainPageView {
  articleCount: number;
  /**
   * The project's article: its title (plain text) and lead (trusted HTML), which open the Main
   * Page, or null when the export has none.
   */
  architecture: { href: string; title: string; leadHtml: string } | null;
  featured: { href: string; leadHtml: string } | null;
  didYouKnow: { html: string; href: string; title: string }[];
  recent: { href: string; title: string; date: string }[];
  /**
   * The In progress box (spec v2 #9 §6.2): the most recently updated open pull requests (plain
   * text titles) and the snapshot's date, or null when the export has no snapshot.
   */
  inProgress: {
    href: string;
    status: string;
    pulls: { href: string; number: number; title: string; date: string }[];
  } | null;
}

/** Deterministic rotation seeded by the head sha: the same export always shows the same page. */
export function rotation(head: string, length: number): number {
  return length === 0 ? 0 : Number.parseInt(head.slice(0, 8), 16) % length;
}

/**
 * "Signals are built." -> "... that signals are built?". Trailing sentence punctuation (also
 * inside a closing quote or bracket) is replaced by one "?"; the first letter is lowercased only
 * before a lowercase letter. Null when no words are left, so the caller skips the hook.
 */
export function didYouKnowText(text: string): string | null {
  const stem = text
    .trim()
    .replace(/[.!?:\u2026]+$/, "")
    .replace(/[.!?:\u2026]+(["\u201d\u2019')\]]+)$/, "$1")
    .trimEnd();
  if (!/[\p{L}\p{N}]/u.test(stem)) return null;
  const lowered = /^[A-Z][a-z]/.test(stem) ? stem.charAt(0).toLowerCase() + stem.slice(1) : stem;
  return `... that ${lowered}?`;
}

/** "3 articles." / "1 article." */
export function articleCountText(count: number): string {
  return `${count} ${count === 1 ? "article" : "articles"}.`;
}

/** Pages of active features, by feature id: what the Main Page counts, features and links to. */
function activePages(site: SiteModel): Revision[] {
  return [...site.pages.values()]
    .filter((page) => site.features.get(page.featureId)?.status.kind === "active")
    .sort((a, b) => (a.featureId < b.featureId ? -1 : 1));
}

/** Same-site URLs /random/ may send the reader to, embedded in the page at build time. */
export function randomTargets(site: SiteModel): string[] {
  return activePages(site).map((page) => articleUrl(page.featureId));
}

export interface AllPagesEntry {
  href: string;
  title: string;
  /** "redirect to X", "disambiguation", "retired", or null for an active feature. */
  note: string | null;
}

/** Every feature that has a page, by title. */
export function allPagesEntries(site: SiteModel): AllPagesEntry[] {
  return site.wiki.manifest.features
    .flatMap((feature) => {
      const link = featureLink(site, feature.id);
      if (link === null) return [];
      const { status } = feature;
      const note =
        status.kind === "redirect"
          ? `redirect to ${site.features.get(status.to)?.title ?? status.to}`
          : status.kind === "disambiguation" || status.kind === "retired"
            ? status.kind
            : null;
      return [{ href: link.href, title: feature.title, note }];
    })
    .sort((a, b) => a.title.localeCompare(b.title, "en"));
}

const calendarDate = (iso: string): string => iso.slice(0, 10);

/** Code-unit order: fixed-width YYYY-MM-DD dates sort correctly without any locale. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function mainPageView(site: SiteModel): MainPageView {
  // Hook text can hold [[links]]; articleLink asks for a hover preview only where one is served.
  const links = inlineOptions(site);
  const active = activePages(site);

  const pick = active[rotation(site.wiki.head, active.length)];
  const featured =
    pick === undefined
      ? null
      : {
          href: articleUrl(pick.featureId),
          leadHtml: leadSummary(site, pick.featureId) ?? "",
        };

  const hooks = active.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.claims
        .filter((claim) => claim.hook)
        .flatMap((claim) => {
          const text = didYouKnowText(claim.text);
          if (text === null) return [];
          return [
            {
              html: renderInline(text, links),
              href: articleUrl(page.featureId),
              title: site.features.get(page.featureId)?.title ?? page.featureId,
            },
          ];
        }),
    ),
  );
  const start = rotation(site.wiki.head, hooks.length);
  const didYouKnow = [...hooks.slice(start), ...hooks.slice(0, start)].slice(0, DID_YOU_KNOW_COUNT);

  const recent = [...site.pages.values()]
    .filter(
      (page) =>
        featureLink(site, page.featureId) !== null &&
        site.features.get(page.featureId)?.status.kind !== "redirect",
    )
    .sort(
      (a, b) =>
        // The date as written first, so the list never contradicts the dates shown.
        compareStrings(calendarDate(b.commitDate), calendarDate(a.commitDate)) ||
        Date.parse(b.commitDate) - Date.parse(a.commitDate) ||
        (a.featureId < b.featureId ? -1 : 1),
    )
    .slice(0, RECENT_COUNT)
    .map((page) => ({
      href: articleUrl(page.featureId),
      title: site.features.get(page.featureId)?.title ?? page.featureId,
      date: formatDate(page.commitDate),
    }));

  const lead = site.architecture?.sections.find((s) => s.key === "lead")?.claims ?? [];
  const architecture =
    site.architecture === null
      ? null
      : {
          href: architectureUrl(),
          title: site.architecture.title,
          leadHtml: lead.map((claim) => renderInline(claim.text, links)).join(" "),
        };

  const inflight = site.wiki.inflight;
  const inProgress =
    inflight === null
      ? null
      : {
          href: inProgressUrl(),
          status: inflightStatus(site, inflight).line,
          pulls: [...inflight.pulls]
            .sort(
              (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.number - b.number,
            )
            .slice(0, IN_PROGRESS_COUNT)
            .map((pull) => ({
              href: pullUrl(pull.number),
              number: pull.number,
              title: pull.title,
              date: formatDate(pull.updatedAt),
            })),
        };

  return { articleCount: active.length, architecture, featured, didYouKnow, recent, inProgress };
}
