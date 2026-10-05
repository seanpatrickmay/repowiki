import type { Claim, WikiExport } from "@repowiki/core";
import { z } from "zod";
import { type SearchDoc, type SearchIndex, searchIndex } from "./search.ts";
import { defineTool, type ToolSet, toolSet } from "./tools.ts";
import { readPage } from "./wiki-page.ts";
import { ABOUT_PAGE_ID, listedPage, reference, WikiView } from "./wiki-view.ts";

/** The most pages one search lists. */
export const MAX_SEARCH_RESULTS = 8;

/** Every active page and the About article as search documents; redirects add their names. */
function searchDocs(view: WikiView): SearchDoc[] {
  const extraNames = new Map<string, string[]>();
  for (const feature of view.wiki.manifest.features) {
    if (feature.status.kind !== "redirect") continue;
    const target = view.finalTarget(feature.id);
    extraNames.set(target, [...(extraNames.get(target) ?? []), feature.title, ...feature.aliases]);
  }
  const claimsText = (
    sections: readonly { key: string; claims: readonly Claim[] }[],
    lead: boolean,
  ) =>
    sections
      .filter((s) => (s.key === "lead") === lead)
      .flatMap((s) => s.claims.flatMap((c) => [view.text(c.text), ...c.citations.map(reference)]))
      .join(" ");
  const docs: SearchDoc[] = view.wiki.pages
    .filter((page) => view.features.get(page.featureId)?.status.kind === "active")
    .map((page) => {
      const feature = view.features.get(page.featureId);
      return {
        id: page.featureId,
        fields: {
          title: `${feature?.title ?? ""} ${page.featureId}`,
          aliases: [...(feature?.aliases ?? []), ...(extraNames.get(page.featureId) ?? [])].join(
            " ",
          ),
          lead: claimsText(page.sections, true),
          body: claimsText(page.sections, false),
        },
      };
    });
  if (view.article !== undefined) {
    docs.push({
      id: ABOUT_PAGE_ID,
      fields: {
        title: `${view.article.title} about`,
        aliases: "",
        lead: claimsText(view.article.sections, true),
        body: claimsText(view.article.sections, false),
      },
    });
  }
  return docs;
}

/** The page search over a view: BM25F over every active page and the About article (R6 of M7). */
export function pageSearchIndex(view: WikiView): SearchIndex {
  return searchIndex(searchDocs(view));
}

/**
 * Up to MAX_SEARCH_RESULTS pages for `query`, best first, one line each (id, title, first lead
 * sentence), then `hint`. `note` adds a few words after a page's line (the MCP server's
 * "(cites changed files)"); without it the text is v1's search result.
 */
export function searchResults(
  view: WikiView,
  index: SearchIndex,
  query: string,
  options: { note?: (id: string) => string | null; hint?: string } = {},
): string {
  const ids = index.search(query, MAX_SEARCH_RESULTS);
  if (ids.length === 0) return "No page matches; try other words.\n";
  const lines = ids.map((id) => {
    const title = id === ABOUT_PAGE_ID ? (view.article?.title ?? "About") : view.title(id);
    const note = options.note?.(id) ?? null;
    return `${listedPage(id, title, view.summary(id))}${note === null ? "" : ` ${note}`}`;
  });
  return `${lines.join("\n")}\n${options.hint ?? "Read one with read_page(id)."}\n`;
}

/**
 * The wiki agent's tools over an export (spec §9): `search(query)` ranks the active pages and the
 * About article by their titles, aliases, leads, claims and cited paths; `read_page(id)` returns
 * one page as plain text (readPage).
 */
export function createWikiTools(wiki: WikiExport): ToolSet {
  const view = new WikiView(wiki);
  const index = pageSearchIndex(view);
  return toolSet([
    defineTool(
      "search",
      `Search the wiki. Returns up to ${MAX_SEARCH_RESULTS} pages, best match first, each with its id, title and the first sentence of its lead.`,
      z.strictObject({ query: z.string().trim().min(1).max(200) }),
      ({ query }) => searchResults(view, index, query),
    ),
    defineTool(
      "read_page",
      `Read one wiki page by its id, as search lists it (${ABOUT_PAGE_ID} is the project's own article). Returns its claims, each with numbered references to the code lines and commits it rests on, its See also list and its dated history.`,
      z.strictObject({ id: z.string().trim().min(1).max(200) }),
      ({ id }) => readPage(view, id),
    ),
  ]);
}
