import { claimAnchor } from "@repowiki/core";
import { ABOUT_PAGE_ID } from "./wiki-view.ts";

/** A feature page id (a slug, as core's FeatureId) and a section key, as links carry them. */
const PAGE_ID = /^[a-z0-9-]{1,64}$/;
const SECTION_KEY = /^[a-z-]{1,32}$/;

/**
 * A page's path on the site: a feature article, or the About article for ABOUT_PAGE_ID. Ids come
 * from the view; one that is not a page id throws rather than build a link that is no page's.
 */
export function pageHref(pageId: string): string {
  if (pageId === ABOUT_PAGE_ID) return "/special/about/";
  if (!PAGE_ID.test(pageId))
    throw new Error(`not a page id: ${JSON.stringify(pageId.slice(0, 80))}`);
  return `/wiki/${pageId}/`;
}

/** A section of a page; the lead has no anchor of its own, so it is the page. */
export function sectionHref(pageId: string, sectionKey: string): string {
  if (sectionKey === "lead") return pageHref(pageId);
  if (!SECTION_KEY.test(sectionKey)) {
    throw new Error(`not a section key: ${JSON.stringify(sectionKey.slice(0, 80))}`);
  }
  return `${pageHref(pageId)}#${sectionKey}`;
}

/**
 * A claim on its page (`#claim-<id>`, spec v2 #4 R17), or its section when the claim's id is not
 * one claimAnchor anchors.
 */
export function claimHref(pageId: string, claimId: string, sectionKey: string): string {
  const anchor = claimAnchor(claimId);
  return anchor === null ? sectionHref(pageId, sectionKey) : `${pageHref(pageId)}#${anchor}`;
}
