import {
  INVISIBLE_CHARACTERS,
  WIKIPEDIA_EXTRACT_MAX_LENGTH,
  type WikipediaCacheEntry,
  WikipediaSummary,
} from "@repowiki/core";
import { CassetteMissError, type FetchLike } from "@repowiki/llm";
import { normalizeWikipediaTitle } from "./links.ts";

/** Wikimedia asks every API client to identify itself; requests without a User-Agent fail. */
export const WIKIPEDIA_USER_AGENT = "RepoWiki/0.1 (https://github.com/seanpatrickmay/repowiki)";
const SUMMARY_ORIGIN = "https://en.wikipedia.org";
const SUMMARY_PATH = "/api/rest_v1/page/summary/";
const CONCURRENCY = 4;
/** How long one lookup may take, headers and body together, before it counts as unreachable. */
export const WIKIPEDIA_TIMEOUT_MS = 10_000;

/** What core's WikipediaSummary refuses in text (ZWJ and ZWNJ are fine). */
const REFUSED = INVISIBLE_CHARACTERS;

/** Where lookups are kept between runs; the store implements it. */
export interface WikipediaCache {
  get(title: string): WikipediaCacheEntry | null;
  put(title: string, summary: WikipediaSummary | null, fetchedAt: string): void;
}

export interface WikipediaOptions {
  cache: WikipediaCache;
  /** Replaces global fetch, e.g. with a cassette in tests. */
  fetch?: FetchLike;
  now?: () => Date;
}

/** What checking a set of titles found. `failed` were not reachable this run and stay uncached. */
export interface WikipediaCheck {
  /** Normalized requested title → the canonical title to link, or null for plain text. */
  links: Map<string, string | null>;
  fetched: number;
  failed: string[];
}

/** Network text as the schema wants it: whitespace runs become one space, refused characters go. */
function plain(value: unknown): string {
  if (typeof value !== "string") return "";
  const spaced = (text: string) => text.replace(/\s+/g, " ").trim();
  return spaced(spaced(value).replace(REFUSED, ""));
}

function cut(text: string): string {
  const chars = [...text];
  if (chars.length <= WIKIPEDIA_EXTRACT_MAX_LENGTH) return text;
  return `${chars
    .slice(0, WIKIPEDIA_EXTRACT_MAX_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * The request URL for a title, or null when the title cannot be put in the path as one segment
 * (a lone surrogate, or `.` and `..`, which a URL parser would fold into the path above).
 */
function summaryUrl(title: string): string | null {
  let segment: string;
  try {
    segment = encodeURIComponent(title.replace(/ /g, "_"));
  } catch {
    return null;
  }
  const url = new URL(`${SUMMARY_PATH}${segment}`, SUMMARY_ORIGIN);
  return url.pathname === `${SUMMARY_PATH}${segment}` ? url.href : null;
}

/**
 * The page summary for a title from the Wikipedia REST API (spec §7.3, F13): a summary, null when
 * there is no article to link (404, or a disambiguation page), or undefined when the API could
 * not be reached or answered something else (a 429 or 5xx included), which is not cached.
 */
async function fetchSummary(
  url: string,
  fetch: FetchLike,
): Promise<WikipediaSummary | null | undefined> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": WIKIPEDIA_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(WIKIPEDIA_TIMEOUT_MS),
    });
  } catch (error) {
    // A cassette that lacks this request is a broken test, not an unreachable Wikipedia.
    if (error instanceof CassetteMissError) throw error;
    return undefined;
  }
  if (response.status === 404) return null;
  if (!response.ok) return undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (body === null || typeof body !== "object") return undefined;
  const page = body as {
    type?: unknown;
    title?: unknown;
    titles?: { normalized?: unknown } | null;
    extract?: unknown;
    content_urls?: { desktop?: { page?: unknown } | null } | null;
  };
  if (page.type === "disambiguation") return null;
  const parsed = WikipediaSummary.safeParse({
    title: normalizeWikipediaTitle(plain(page.titles?.normalized ?? page.title)),
    extract: cut(plain(page.extract)),
    url: page.content_urls?.desktop?.page ?? "",
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Checks every [[wp:Title]] target once, through the cache: a cached title is never fetched
 * again. A summary is cached under the requested title and under its canonical one, which is
 * the title links name and the export keys summaries by.
 */
export async function checkWikipediaTitles(
  titles: Iterable<string>,
  options: WikipediaOptions,
): Promise<WikipediaCheck> {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const wanted = [...new Set([...titles].map(normalizeWikipediaTitle))]
    .filter((t) => t !== "")
    .sort();
  const check: WikipediaCheck = { links: new Map(), fetched: 0, failed: [] };
  const missing: string[] = [];
  for (const title of wanted) {
    const cached = options.cache.get(title);
    if (cached === null) missing.push(title);
    else check.links.set(title, cached.summary?.title ?? null);
  }
  // Redirect targets: canonical title → the summary a redirecting lookup brought back for it.
  const redirected = new Map<string, WikipediaSummary>();
  const lookUp = async (title: string): Promise<void> => {
    const url = summaryUrl(title);
    if (url === null) {
      // Cannot be an article and cannot be put in a path: plain, with nothing to retry or cache.
      check.links.set(title, null);
      return;
    }
    const summary = await fetchSummary(url, fetch);
    check.fetched += 1;
    if (summary === undefined) {
      check.failed.push(title);
      check.links.set(title, null);
      return;
    }
    const at = now().toISOString();
    options.cache.put(title, summary, at);
    if (summary !== null && summary.title !== title) {
      redirected.set(summary.title, summary);
      // Never overwrite what is already known about the canonical title.
      if (options.cache.get(summary.title) === null) {
        options.cache.put(summary.title, summary, at);
      }
    }
    check.links.set(title, summary?.title ?? null);
  };
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    await Promise.all(missing.slice(i, i + CONCURRENCY).map(lookUp));
  }
  // A title another lookup redirected to links to itself, whatever its own lookup found.
  for (const title of redirected.keys()) {
    if (wanted.includes(title)) {
      check.links.set(title, title);
      check.failed = check.failed.filter((failed) => failed !== title);
    }
  }
  check.failed.sort();
  // Lookups finish in any order; the result lists titles sorted, like `wanted`.
  check.links = new Map(wanted.map((title) => [title, check.links.get(title) ?? null]));
  return check;
}
