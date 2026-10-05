import { ASK_QUESTION_MAX_LENGTH, ASK_TITLE_MAX_LENGTH } from "@repowiki/core";
import {
  ABOUT_PAGE_ID,
  type ClaimIndex,
  claimLine,
  claimSearchIndex,
  cut,
  listedPage,
  oneLine,
  pageSearchIndex,
  type SearchIndex,
  titleText,
  toolText,
  unmarkHandles,
  type WikiView,
} from "@repowiki/query";

/** The most pages and claims the turn-1 pack lists, and the most claims from one page. */
export const PACK_PAGES = 5;
export const PACK_CLAIMS = 12;
export const PACK_CLAIMS_PER_PAGE = 4;

/** The searches one export's questions share, built once per session. */
export interface AskIndexes {
  pages: SearchIndex;
  claims: ClaimIndex;
}

export function askIndexes(view: WikiView): AskIndexes {
  return { pages: pageSearchIndex(view), claims: claimSearchIndex(view) };
}

/**
 * The page a hint names, as a page id (a feature id or ABOUT_PAGE_ID), or null when it names none
 * a reader can be on: unknown ids, choices and anything else are ignored (spec v2 #4 R9).
 */
export function hintedPage(view: WikiView, page: string | null): string | null {
  if (page === null) return null;
  try {
    const resolved = view.resolve(page);
    if (resolved.kind === "about") return ABOUT_PAGE_ID;
    return resolved.kind === "page" ? resolved.featureId : null;
  } catch {
    return null;
  }
}

const pageTitle = (view: WikiView, id: string) =>
  id === ABOUT_PAGE_ID ? (view.article?.title ?? "About") : view.title(id);

/** The first user turn of a question and the handles it shows. */
export interface Pack {
  text: string;
  shown: string[];
}

/**
 * The first user turn (spec v2 #4 §6.2): the question; the page the reader is on; the top pages
 * of the page search, the hinted page first; and the top claims of the claim search, at most
 * PACK_CLAIMS_PER_PAGE from one page, each starting with its handle. Every repository-derived
 * string goes through query's neutralisation: the reader's page title through `titleText`, cut
 * at ASK_TITLE_MAX_LENGTH, and every page line and title with its handle-shaped text unmarked.
 */
export function turnOnePack(
  view: WikiView,
  indexes: AskIndexes,
  question: string,
  hint: string | null,
): Pack {
  const asked = cut(oneLine(toolText(question)), ASK_QUESTION_MAX_LENGTH);
  const lines = [`Question: ${asked}`];
  if (hint !== null) {
    const title = cut(titleText(pageTitle(view, hint)), ASK_TITLE_MAX_LENGTH);
    lines.push(`The reader is on: ${unmarkHandles(`${title} (page id: ${hint})`)}`);
  }
  const found = indexes.pages.search(asked, PACK_PAGES);
  const pages =
    hint === null || found.includes(hint) ? found : [hint, ...found].slice(0, PACK_PAGES);
  lines.push("", "Pages that match:");
  if (pages.length === 0) lines.push("- none");
  for (const id of pages) {
    lines.push(unmarkHandles(listedPage(id, pageTitle(view, id), view.summary(id))));
  }
  const shown = indexes.claims.search(asked, PACK_CLAIMS, PACK_CLAIMS_PER_PAGE);
  lines.push("", "Claims that match:");
  if (shown.length === 0) lines.push("- none");
  for (const handle of shown) {
    const entry = indexes.claims.entries.get(handle);
    if (entry !== undefined) lines.push(claimLine(view, entry));
  }
  lines.push("", "Read a page with read_page(id) for its other claims.");
  return { text: `${lines.join("\n")}\n`, shown };
}
