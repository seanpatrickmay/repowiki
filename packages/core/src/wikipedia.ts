import { z } from "zod";
import { INVISIBLE_CHARACTERS } from "./alias.ts";
import { IsoDateTime } from "./primitives.ts";

/** Longest extract kept, in code points: the hover preview shows a few sentences, not an article. */
export const WIKIPEDIA_EXTRACT_MAX_LENGTH = 1200;

/**
 * Wikipedia's form of a title for comparing and caching: spaces for underscores, runs of
 * whitespace collapsed, the first letter upper case (Wikipedia ignores its case).
 */
export function normalizeWikipediaTitle(title: string): string {
  const spaced = title.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return spaced === "" ? "" : `${spaced[0]?.toUpperCase()}${spaced.slice(1)}`;
}

/**
 * Characters the reader must never be handed inside a preview: C0/C1 controls (including
 * newlines and tabs), the Unicode line and paragraph separators, and every invisible format
 * character (\p{Cf}): the bidirectional marks, embeddings, overrides and isolates that reorder
 * the text around them, plus tag characters, word joiners, invisible operators, byte order marks,
 * zero-width spaces and soft hyphens, which hide text. The zero-width joiner and non-joiner are
 * kept: Indic and Persian scripts need them to spell words.
 */
const CONTROL_OR_INVISIBLE = new RegExp(INVISIBLE_CHARACTERS.source, "u");

const plainText = (text: string): boolean => !CONTROL_OR_INVISIBLE.test(text);

/**
 * True for an English Wikipedia article URL in the one form the URL parser writes: https, host
 * exactly en.wikipedia.org, no credentials and no port, a path under /wiki/, no query and no fragment. Comparing with the
 * parsed href refuses anything the parser would rewrite (spaces, quotes, backslashes, an explicit
 * default port, an upper-case host), so the stored string is the string a browser follows.
 */
function isWikipediaArticleUrl(value: string): boolean {
  const url = URL.parse(value);
  return (
    url !== null &&
    url.href === value &&
    url.protocol === "https:" &&
    url.hostname === "en.wikipedia.org" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.pathname.startsWith("/wiki/") &&
    url.pathname.length > "/wiki/".length &&
    url.search === "" &&
    url.hash === "" &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

/**
 * The part of a Wikipedia REST page summary the reader shows as a hover preview (F13). The text
 * comes from the network, so it is untrusted: plain text only, capped, and the URL is always an
 * English Wikipedia article URL, never anything an export could abuse.
 */
export const WikipediaSummary = z.object({
  /** Wikipedia's canonical title, which [[wp:…]] links name. */
  title: z
    .string()
    .min(1)
    .refine(plainText, "must not contain control or invisible format characters"),
  extract: z
    .string()
    .refine(
      (text) => [...text].length <= WIKIPEDIA_EXTRACT_MAX_LENGTH,
      `must be at most ${WIKIPEDIA_EXTRACT_MAX_LENGTH} characters`,
    )
    .refine(plainText, "must not contain control or invisible format characters"),
  url: z.string().refine(isWikipediaArticleUrl, "expected an en.wikipedia.org article URL"),
});
export type WikipediaSummary = z.infer<typeof WikipediaSummary>;

/** A cached lookup: the summary, or null when the title has no article to link (404 or a disambiguation page). */
export const WikipediaCacheEntry = z.object({
  summary: WikipediaSummary.nullable(),
  fetchedAt: IsoDateTime,
});
export type WikipediaCacheEntry = z.infer<typeof WikipediaCacheEntry>;
