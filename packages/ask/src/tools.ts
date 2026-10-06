import {
  ABOUT_PAGE_ID,
  defineTool,
  type LocalToolSet,
  MAX_SEARCH_RESULTS,
  readPageWithHandles,
  type SearchIndex,
  searchResults,
  toolSet,
  type WikiView,
} from "@repowiki/query";
import { z } from "zod";

/** What the ask's tools report as they run: for progress events and the shown handles. */
export interface AskToolEvents {
  searched(query: string): void;
  read(page: { pageId: string; title: string; handles: readonly string[] }): void;
}

/**
 * The ask's `search` and `read_page` (spec v2 #4 §6.1): the wiki agent's tools with the same
 * names and input schemas, `read_page` in handles mode (readPageWithHandles: each claim starts
 * with its handle, and the page history is left out, R22), so its description says so.
 */
export function createAskTools(
  view: WikiView,
  pages: SearchIndex,
  events: AskToolEvents,
): LocalToolSet {
  return toolSet([
    defineTool(
      "search",
      `Search the wiki. Returns up to ${MAX_SEARCH_RESULTS} pages, best match first, each with its id, title and the first sentence of its lead.`,
      z.strictObject({ query: z.string().trim().min(1).max(200) }),
      ({ query }) => {
        events.searched(query);
        return searchResults(view, pages, query);
      },
    ),
    defineTool(
      "read_page",
      `Read one wiki page by its id, as search lists it (${ABOUT_PAGE_ID} is the project's own article). Returns its claims, each starting with its handle in braces and followed by numbered references to the code lines and commits it rests on, and its See also list.`,
      z.strictObject({ id: z.string().trim().min(1).max(200) }),
      ({ id }) => {
        const resolved = view.resolve(id);
        const page = readPageWithHandles(view, id);
        if (resolved.kind !== "choices") {
          const pageId = resolved.kind === "about" ? ABOUT_PAGE_ID : resolved.featureId;
          const title =
            resolved.kind === "about" ? (view.article?.title ?? "About") : view.title(pageId);
          events.read({ pageId, title, handles: page.handles });
        }
        return page.text;
      },
    ),
  ]);
}
