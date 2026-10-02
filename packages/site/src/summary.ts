import { renderInline } from "./inline.ts";
import { featureLink, type SiteModel } from "./model.ts";

/** The lead of a feature's current page as link-free HTML, or null when it has no page. */
export function leadSummary(site: SiteModel, featureId: string): string | null {
  const lead = site.pages.get(featureId)?.sections.find((section) => section.key === "lead");
  if (lead === undefined) return null;
  const link = (id: string) => featureLink(site, id);
  return lead.claims.map((claim) => renderInline(claim.text, { link, links: false })).join(" ");
}
