import type { Citation, Claim } from "@repowiki/core";
import { handleOf, hasHandle, unmarkHandles } from "./ask-page.ts";
import { searchIndex } from "./search.ts";
import { cut, oneLine } from "./text.ts";
import { ABOUT_PAGE_ID, type WikiView } from "./wiki-view.ts";

/** How much a claim's match counts by field (spec v2 #4 §6.2): its page's title counts twice. */
export const CLAIM_BOOST = { title: 2, text: 1, cites: 1 } as const;

/** The longest claim text a pack line shows, in code points; read_page shows a claim whole. */
export const CLAIM_LINE_TEXT_LENGTH = 300;

/** The most references a pack line names. */
export const CLAIM_LINE_REFERENCES = 3;

/** The longest path a pack line's reference shows, in code points (a path has no maximum). */
export const CLAIM_LINE_REFERENCE_LENGTH = 120;

/** The claim search's `limit` and `perPage` when the caller's is not a number. */
export const CLAIM_SEARCH_LIMIT = 12;
export const CLAIM_SEARCH_PER_PAGE = 4;

/** `n` as a whole count of at least 1, or `fallback` when it is not a finite number. */
const atLeastOne = (n: number, fallback: number): number =>
  Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : fallback;

/** A claim that can be cited, with its page. */
export interface ClaimEntry {
  handle: string;
  pageId: string;
  claim: Claim;
}

/** The claim-level search of the Ask sidebar's turn-1 pack. */
export interface ClaimIndex {
  entries: ReadonlyMap<string, ClaimEntry>;
  /**
   * Handles of the best claims for `query`, best first, ties by handle: at most `limit`, and at
   * most `perPage` from one page. Each is taken as a whole number of at least 1; one that is not
   * a finite number is CLAIM_SEARCH_LIMIT or CLAIM_SEARCH_PER_PAGE.
   */
  search(query: string, limit: number, perPage: number): string[];
}

/** Every citable claim of the active pages and the About article (C9: no other page kind). */
function claimEntries(view: WikiView): ClaimEntry[] {
  const pages: { pageId: string; sections: readonly { claims: readonly Claim[] }[] }[] = [
    ...view.wiki.pages
      .filter((page) => view.features.get(page.featureId)?.status.kind === "active")
      .map((page) => ({ pageId: page.featureId, sections: page.sections })),
    ...(view.article === undefined
      ? []
      : [{ pageId: ABOUT_PAGE_ID, sections: view.article.sections }]),
  ];
  return pages.flatMap(({ pageId, sections }) =>
    sections.flatMap((section) =>
      section.claims
        .filter((claim) => hasHandle(claim.id))
        .map((claim) => ({ handle: handleOf(pageId, claim.id), pageId, claim })),
    ),
  );
}

const titleOf = (view: WikiView, pageId: string) =>
  pageId === ABOUT_PAGE_ID
    ? `${view.article?.title ?? ""} about`
    : `${view.title(pageId)} ${pageId}`;

/**
 * BM25F over one document per citable claim: its page's title (×2), its text, and the paths and
 * symbols it cites, over the active pages and the About article.
 */
export function claimSearchIndex(view: WikiView): ClaimIndex {
  const entries = claimEntries(view);
  const byHandle = new Map(entries.map((entry) => [entry.handle, entry]));
  const index = searchIndex(
    entries.map(({ handle, pageId, claim }) => ({
      id: handle,
      fields: {
        title: titleOf(view, pageId),
        text: view.text(claim.text),
        cites: claim.citations
          .flatMap((c) => (c.kind === "code" ? [c.path, c.symbol ?? ""] : []))
          .join(" "),
      },
    })),
    CLAIM_BOOST,
  );
  return {
    entries: byHandle,
    search(query, limitAsked, perPageAsked) {
      const limit = atLeastOne(limitAsked, CLAIM_SEARCH_LIMIT);
      const perPage = atLeastOne(perPageAsked, CLAIM_SEARCH_PER_PAGE);
      const counts = new Map<string, number>();
      const picked: string[] = [];
      for (const handle of index.search(query, entries.length)) {
        if (picked.length >= limit) break;
        const pageId = byHandle.get(handle)?.pageId ?? "";
        const n = counts.get(pageId) ?? 0;
        if (n >= perPage) continue;
        counts.set(pageId, n + 1);
        picked.push(handle);
      }
      return picked;
    },
  };
}

/**
 * A citation as a pack line names it: `path:start-end`, its path cut at
 * CLAIM_LINE_REFERENCE_LENGTH, or `commit <sha7>`.
 */
const shortReference = (citation: Citation): string =>
  citation.kind === "code"
    ? `${cut(oneLine(citation.path), CLAIM_LINE_REFERENCE_LENGTH)}:${citation.startLine}-${citation.endLine}`
    : `commit ${citation.sha.slice(0, 7)}`;

/**
 * One claim as the turn-1 pack lists it: `- {page#claim} <text> (cites: a.ts:1-9, …)`, its text
 * one line and cut at CLAIM_LINE_TEXT_LENGTH, with at most CLAIM_LINE_REFERENCES distinct
 * references. Everything after the line's own handle is unmarked as one string, so a mark cannot
 * be formed across the text and a reference (an open `{a#b` and a path holding `}`).
 */
export function claimLine(view: WikiView, entry: ClaimEntry): string {
  const text = cut(view.text(entry.claim.text), CLAIM_LINE_TEXT_LENGTH);
  const refs = [...new Set(entry.claim.citations.map(shortReference))];
  const shown = refs.slice(0, CLAIM_LINE_REFERENCES);
  const more =
    refs.length > CLAIM_LINE_REFERENCES ? `, and ${refs.length - CLAIM_LINE_REFERENCES} more` : "";
  const cites = shown.length === 0 ? "" : ` (cites: ${shown.join(", ")}${more})`;
  return `- {${entry.handle}} ${unmarkHandles(`${text}${cites}`)}`;
}
