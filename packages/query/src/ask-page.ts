import type { Claim } from "@repowiki/core";
import { MAX_TOOL_RESULT_CHARS } from "./tools.ts";
import { readPage } from "./wiki-page.ts";
import { ABOUT_PAGE_ID, type WikiView } from "./wiki-view.ts";

/** A claim's handle as the Ask sidebar cites it: `<pageId>#<claimId>` (spec v2 #4 §5.2). */
export const handleOf = (pageId: string, claimId: string): string => `${pageId}#${claimId}`;

/** Claim ids a handle can carry: a page's `#` separates page and claim, `}` closes the mark. */
const HANDLE_CLAIM_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** True when a claim with this id gets a handle; other claims are shown but cannot be cited. */
export const hasHandle = (claimId: string): boolean => HANDLE_CLAIM_ID.test(claimId);

const HANDLE_SHAPED = /\{([^{}\n]*#[^{}\n]*)\}/g;

/**
 * Wiki text with every handle-shaped `{…#…}` made `(…#…)`, so only the server's own handles,
 * at the start of a claim's bullet, look like handles to the model. It repeats until nothing
 * changes, so nested marks such as `{x{a#b}#y}` are unmarked too (each pass removes braces).
 */
export function unmarkHandles(text: string): string {
  let before = text;
  for (;;) {
    const after = before.replace(HANDLE_SHAPED, "($1)");
    if (after === before) return after;
    before = after;
  }
}

/** A page as the ask's read_page returns it, and the handles of the claims it shows. */
export interface PageWithHandles {
  text: string;
  handles: string[];
}

const codePoints = (lines: readonly string[]) => [...`${lines.join("\n")}\n`].length;

/**
 * One page as the Ask sidebar's model reads it (spec v2 #4 R22): readPage with a handle
 * `{<pageId>#<claimId>}` at the start of each claim's bullet and no page history, every other
 * handle-shaped text unmarked, and whole lines left out past `max` code points. `handles` are
 * exactly the handles the text shows, in order; a page of choices shows none. The renderer first
 * marks each bullet with a random token no export can contain, so claim text that imitates a
 * handle at the start of a bullet is unmarked like any other text.
 */
export function readPageWithHandles(
  view: WikiView,
  id: string,
  max = MAX_TOOL_RESULT_CHARS,
): PageWithHandles {
  const resolved = view.resolve(id);
  const pageId =
    resolved.kind === "about"
      ? ABOUT_PAGE_ID
      : resolved.kind === "page"
        ? resolved.featureId
        : null;
  const token = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const marked: string[] = [];
  const page = readPage(view, id, max, {
    history: false,
    claimHandle: (claimId) => {
      if (pageId === null || !hasHandle(claimId)) return null;
      marked.push(handleOf(pageId, claimId));
      return `\u27E6${token}:${marked.length - 1}\u27E7`;
    },
  });
  const bullet = new RegExp(`^- \u27E6${token}:(\\d+)\u27E7 `);
  const lines = page
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const match = bullet.exec(line);
      const handle = match === null ? undefined : marked[Number(match[1])];
      return handle === undefined || match === null
        ? { text: unmarkHandles(line), handle: null }
        : {
            text: `- {${handle}} ${unmarkHandles(line.slice(match[0].length))}`,
            handle,
          };
    });
  let kept = lines;
  let note: string[] = [];
  if (codePoints(lines.map((l) => l.text)) > max) {
    note = ["", `(The page is cut at the ${max}-character limit.)`];
    kept = [];
    for (const line of lines) {
      if (codePoints([...kept.map((l) => l.text), line.text, ...note]) > max) break;
      kept.push(line);
    }
  }
  const handles = [...new Set(kept.flatMap((l) => (l.handle === null ? [] : [l.handle])))];
  return { text: `${[...kept.map((l) => l.text), ...note].join("\n")}\n`, handles };
}

/** What a handle names: its page, the claim, and the claim's section. */
export interface HandleClaim {
  handle: string;
  pageId: string;
  /** The page's title, and its other names (none for the About article). */
  pageTitle: string;
  aliases: readonly string[];
  sectionKey: string;
  claim: Claim;
}

/** The claim a handle names in the view's current pages, or null when it names none. */
export function handleClaim(view: WikiView, handle: string): HandleClaim | null {
  const at = handle.indexOf("#");
  if (at <= 0) return null;
  const pageId = handle.slice(0, at);
  const claimId = handle.slice(at + 1);
  const about = pageId === ABOUT_PAGE_ID;
  const sections = about ? view.article?.sections : view.pages.get(pageId)?.sections;
  for (const section of sections ?? []) {
    const claim = section.claims.find((c) => c.id === claimId);
    if (claim === undefined) continue;
    return {
      handle,
      pageId,
      pageTitle: about ? (view.article?.title ?? "About") : view.title(pageId),
      aliases: about ? [] : (view.features.get(pageId)?.aliases ?? []),
      sectionKey: section.key,
      claim,
    };
  }
  return null;
}
