/** Every page URL the site emits. Feature ids and alias slugs are URL-safe kebab-case. */
export const articleUrl = (id: string): string => `/wiki/${id}/`;
export const historyUrl = (id: string): string => `/wiki/${id}/history/`;
/** n is the 1-based position in the feature's history, oldest first. */
export const oldRevisionUrl = (id: string, n: number): string => `/wiki/${id}/history/${n}/`;
/** Diff of revision n against revision n - 1. */
export const diffUrl = (id: string, n: number): string => `/wiki/${id}/diff/${n}/`;
export const previewUrl = (id: string): string => `/api/preview/${id}.json`;
/** The project's own article (F27). Under /special/, so no feature id or alias can take it. */
export const ARCHITECTURE_URL = "/special/about/";
/** Open pull requests and planned work (spec v2 #9 §6.2). */
export const IN_PROGRESS_URL = "/special/in-progress/";
/** One open pull request's page. */
export const pullUrl = (n: number): string => `${IN_PROGRESS_URL}pr/${n}/`;
/** The Ask panel as a page of its own (spec v2 #4 R21). */
export const ASK_URL = "/special/ask/";

/** English Wikipedia article URL for a [[wp:Title]] token. */
export function wikipediaUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.trim().replace(/ /g, "_"))}`;
}
/** The People index (spec v2 #6 §11). */
export const PEOPLE_URL = "/people/";
/** A person's page; an id merged away keeps a redirect page here. */
export const personUrl = (id: string): string => `${PEOPLE_URL}${id}/`;
/** The People index's part for one feature. */
export const peopleFeatureUrl = (featureId: string): string => `${PEOPLE_URL}#feature-${featureId}`;
/** The repository's activity: all time, a year (`2026`) or a month (`2026-03`). */
export const activityUrl = (period?: string): string =>
  `/special/activity/${period === undefined ? "" : `${period}/`}`;
