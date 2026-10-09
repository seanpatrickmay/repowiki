import type { Claim } from "@repowiki/core";

/** A group whose claims add up to this many characters of markdown is closed before the next claim. */
export const PARAGRAPH_CHARS = 550;
/** A last paragraph of one claim shorter than this joins the paragraph before it. */
export const ORPHAN_CHARS = 200;

/**
 * Splits a section's claims into paragraphs, in order. A group closes before a claim when it
 * already holds two claims and either its length has reached PARAGRAPH_CHARS or the claim and
 * the group both cite code and share no file (the section moved to another part of the code).
 * A last group of one short claim joins the group before it.
 */
export function paragraphGroups<T>(
  claims: readonly T[],
  filesOf: (claim: T) => ReadonlySet<string>,
  lengthOf: (claim: T) => number,
): T[][] {
  const groups: T[][] = [];
  let group: T[] = [];
  let files = new Set<string>();
  let length = 0;
  for (const claim of claims) {
    const own = filesOf(claim);
    const moved = own.size > 0 && files.size > 0 && ![...own].some((f) => files.has(f));
    if (group.length >= 2 && (length >= PARAGRAPH_CHARS || moved)) {
      groups.push(group);
      group = [];
      files = new Set();
      length = 0;
    }
    group.push(claim);
    for (const f of own) files.add(f);
    length += lengthOf(claim);
  }
  if (group.length > 0) groups.push(group);
  const last = groups.at(-1);
  const before = groups.at(-2);
  const only = last?.[0];
  if (last?.length === 1 && only !== undefined && before !== undefined) {
    if (lengthOf(only) < ORPHAN_CHARS) {
      before.push(only);
      groups.pop();
    }
  }
  return groups;
}

/** `<p>…</p>` per group; a paragraph's claims are joined with a space. */
export function paragraphsHtml(groups: readonly (readonly string[])[]): string {
  return groups.map((group) => `<p>${group.join(" ")}</p>`).join("");
}

/** `<ul class="claim-list">` with one `<li>` per item; nothing for no items. */
export function listHtml(items: readonly string[]): string {
  if (items.length === 0) return "";
  return `<ul class="claim-list">${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

/** `list-or-paragraph` is a list from two claims on, else one paragraph. */
export type SectionLayout = "paragraphs" | "list" | "list-or-paragraph";

/** How each section of a feature article lays out its claims. The lead is never laid out here. */
export const ARTICLE_LAYOUTS: Record<
  "overview" | "how-it-works" | "data-flow" | "history" | "known-limitations",
  SectionLayout
> = {
  overview: "paragraphs",
  "how-it-works": "paragraphs",
  "data-flow": "paragraphs",
  history: "list",
  "known-limitations": "list-or-paragraph",
};

/** The same for the About article. */
export const ARCHITECTURE_LAYOUTS: Record<
  "purpose" | "layers" | "dependencies" | "infrastructure" | "request-paths",
  SectionLayout
> = {
  purpose: "paragraphs",
  layers: "list",
  dependencies: "list",
  infrastructure: "list",
  "request-paths": "list",
};

/** The paths of a claim's code citations. */
export function codeFiles(claim: Pick<Claim, "citations">): Set<string> {
  return new Set(claim.citations.flatMap((c) => (c.kind === "code" ? [c.path] : [])));
}

/** A section's block markup: its claims, each rendered by `render`, laid out as `layout` says. */
export function sectionHtml<T extends Pick<Claim, "citations" | "text">>(
  layout: SectionLayout,
  claims: readonly T[],
  render: (claim: T) => string,
): string {
  if (claims.length === 0) return "";
  if (layout === "list" || (layout === "list-or-paragraph" && claims.length >= 2)) {
    return listHtml(claims.map(render));
  }
  const groups =
    layout === "paragraphs"
      ? paragraphGroups(claims, codeFiles, (c) => c.text.length)
      : [[...claims]];
  return paragraphsHtml(groups.map((group) => group.map(render)));
}
