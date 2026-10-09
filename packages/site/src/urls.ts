import { PersonId } from "@repowiki/core";
import { parseBase } from "./args.ts";

/**
 * The path the site being built is served under (`--base`, issue #610): REPOWIKI_BASE, which
 * buildSite sets on every build, validated again because it is spliced into HTML unescaped; "/"
 * outside a build. Read on every call, because Astro reuses this module across builds.
 */
export function siteBase(): string {
  const base = process.env.REPOWIKI_BASE;
  return base === undefined || base === "" ? "/" : parseBase(base, "REPOWIKI_BASE");
}

/**
 * A root-absolute site path ("/wiki/x/") as the URL the built site links it by: under the base.
 * Every same-site URL the site writes goes through here, once; with the base "/" it is the path.
 */
export function withBase(path: string, base: string = siteBase()): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`withBase takes a root-absolute site path, got ${JSON.stringify(path)}`);
  }
  return `${base}${path.slice(1)}`;
}

/** Every page URL the site emits. Feature ids and alias slugs are URL-safe kebab-case. */
export const articleUrl = (id: string): string => withBase(`/wiki/${id}/`);
export const historyUrl = (id: string): string => withBase(`/wiki/${id}/history/`);
/** n is the 1-based position in the feature's history, oldest first. */
export const oldRevisionUrl = (id: string, n: number): string =>
  withBase(`/wiki/${id}/history/${n}/`);
/** Diff of revision n against revision n - 1. */
export const diffUrl = (id: string, n: number): string => withBase(`/wiki/${id}/diff/${n}/`);
export const previewUrl = (id: string): string => withBase(`/api/preview/${id}.json`);
/** The project's own article (F27). Under /special/, so no feature id or alias can take it. */
export const architectureUrl = (): string => withBase("/special/about/");
/** Open pull requests and planned work (spec v2 #9 §6.2). */
export const inProgressUrl = (): string => withBase("/special/in-progress/");
/** One open pull request's page. */
export const pullUrl = (n: number): string => `${inProgressUrl()}pr/${n}/`;

/** English Wikipedia article URL for a [[wp:Title]] token. */
export function wikipediaUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.trim().replace(/ /g, "_"))}`;
}
/** The People index (spec v2 #6 §11). */
export const peopleUrl = (): string => withBase("/people/");
/** A person's page; an id merged away keeps a redirect page here. */
export const personUrl = (id: string): string => `${peopleUrl()}${PersonId.parse(id)}/`;
/** The People index's part for one feature. */
export const peopleFeatureUrl = (featureId: string): string =>
  `${peopleUrl()}#feature-${featureId}`;
/** The repository's activity: all time, a year (`2026`) or a month (`2026-03`). */
export const activityUrl = (period?: string): string =>
  withBase(`/special/activity/${period === undefined ? "" : `${period}/`}`);
