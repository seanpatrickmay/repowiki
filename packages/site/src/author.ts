import { UsageError } from "./args.ts";

/** Whose wiki this is, and where their biography lives (ADR-0013); hosted builds only. */
export interface SiteAuthor {
  name: string;
  /** A root-absolute path on the pages origin, such as "/ada". */
  url: string;
}

const PATH = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/;

/** The author checked and encoded for REPOWIKI_AUTHOR; "" for a site without one. */
export function authorEnv(author: SiteAuthor | undefined): string {
  if (author === undefined) return "";
  const name = author.name.trim();
  if (name === "" || name.length > 120)
    throw new UsageError("the author's name must be 1–120 characters");
  if (!PATH.test(author.url)) {
    throw new UsageError("the author's URL must be a root-absolute path of plain segments");
  }
  return JSON.stringify({ name, url: author.url });
}

/**
 * The author the current build was given (REPOWIKI_AUTHOR, which buildSite sets on every build),
 * checked again since it is spliced into every page; null without one. Read on every call,
 * because Astro reuses this module across builds.
 */
export function siteAuthor(): SiteAuthor | null {
  const value = process.env.REPOWIKI_AUTHOR;
  if (value === undefined || value === "") return null;
  const parsed = JSON.parse(value) as SiteAuthor;
  return JSON.parse(authorEnv(parsed)) as SiteAuthor;
}
