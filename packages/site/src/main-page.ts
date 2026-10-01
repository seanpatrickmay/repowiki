import { formatDate } from "./format.ts";
import { renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";
import { articleLink } from "./preview.ts";
import { leadSummary } from "./summary.ts";
import { articleUrl } from "./urls.ts";

export const DID_YOU_KNOW_COUNT = 5;
export const RECENT_COUNT = 5;

export interface MainPageView {
  articleCount: number;
  featured: { href: string; title: string; leadHtml: string } | null;
  didYouKnow: { html: string; href: string; title: string }[];
  recent: { href: string; title: string; date: string }[];
}

/** Deterministic rotation seeded by the head sha: the same export always shows the same page. */
export function rotation(head: string, length: number): number {
  return length === 0 ? 0 : Number.parseInt(head.slice(0, 8), 16) % length;
}

/** "Signals are built." -> "... that signals are built?" (lowercased only before a lowercase letter). */
export function didYouKnowText(text: string): string {
  const question = text.trim().replace(/[.!]$/, "?");
  const lowered = /^[A-Z][a-z]/.test(question)
    ? question.charAt(0).toLowerCase() + question.slice(1)
    : question;
  return `... that ${lowered}${lowered.endsWith("?") ? "" : "?"}`;
}

export function mainPageView(site: SiteModel): MainPageView {
  // Hook text can hold [[links]]; articleLink asks for a hover preview only where one is served.
  const link = (id: string) => articleLink(site, id);
  const active = [...site.pages.values()]
    .filter((page) => site.features.get(page.featureId)?.status.kind === "active")
    .sort((a, b) => (a.featureId < b.featureId ? -1 : 1));

  const pick = active[rotation(site.wiki.head, active.length)];
  const featured =
    pick === undefined
      ? null
      : {
          href: articleUrl(pick.featureId),
          title: site.features.get(pick.featureId)?.title ?? pick.featureId,
          leadHtml: leadSummary(site, pick.featureId) ?? "",
        };

  const hooks = active.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.claims
        .filter((claim) => claim.hook)
        .map((claim) => ({
          html: renderInline(didYouKnowText(claim.text), { link }),
          href: articleUrl(page.featureId),
          title: site.features.get(page.featureId)?.title ?? page.featureId,
        })),
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
        Date.parse(b.commitDate) - Date.parse(a.commitDate) || (a.featureId < b.featureId ? -1 : 1),
    )
    .slice(0, RECENT_COUNT)
    .map((page) => ({
      href: articleUrl(page.featureId),
      title: site.features.get(page.featureId)?.title ?? page.featureId,
      date: formatDate(page.commitDate),
    }));

  return { articleCount: active.length, featured, didYouKnow, recent };
}
