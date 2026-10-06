import { claimAnchor } from "@repowiki/core";
import { ABOUT_PAGE_ID } from "./wiki-view.ts";

/** A page's path on the site: a feature article, or the About article for ABOUT_PAGE_ID. */
export function pageHref(pageId: string): string {
  return pageId === ABOUT_PAGE_ID ? "/special/about/" : `/wiki/${pageId}/`;
}

/** A section of a page; the lead has no anchor of its own, so it is the page. */
export function sectionHref(pageId: string, sectionKey: string): string {
  return sectionKey === "lead" ? pageHref(pageId) : `${pageHref(pageId)}#${sectionKey}`;
}

/**
 * A claim on its page (`#claim-<id>`, spec v2 #4 R17), or its section when the claim's id is not
 * one claimAnchor anchors.
 */
export function claimHref(pageId: string, claimId: string, sectionKey: string): string {
  const anchor = claimAnchor(claimId);
  return anchor === null ? sectionHref(pageId, sectionKey) : `${pageHref(pageId)}#${anchor}`;
}
