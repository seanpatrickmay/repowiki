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
/** The Ask panel as a page of its own (spec v2 #4 R21). */
export const ASK_URL = "/special/ask/";

/** English Wikipedia article URL for a [[wp:Title]] token. */
export function wikipediaUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.trim().replace(/ /g, "_"))}`;
}
