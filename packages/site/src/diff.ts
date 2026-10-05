import { claimChanges, type Revision, SectionKey, wordDiff } from "@repowiki/core";
import { SECTION_TITLES } from "./article.ts";
import { escapeHtml } from "./inline.ts";

/** Word-level diff of one rewritten claim, as HTML with <del> and <ins>; runs are merged. */
export function wordDiffHtml(before: string, after: string): string {
  return wordDiff(before, after)
    .map(({ op, value }) => {
      const text = escapeHtml(value);
      return op === "equal" ? text : op === "delete" ? `<del>${text}</del>` : `<ins>${text}</ins>`;
    })
    .join("");
}

export interface DiffRow {
  kind: "context" | "removed" | "added" | "changed";
  html: string;
}

export interface DiffSection {
  title: string;
  rows: DiffRow[];
}

/**
 * Claim-by-claim diff of the stored claim text (the page's source, as Wikipedia diffs show
 * wikitext), from core's claimChanges. Sections with no change are omitted. A run of removed
 * claims followed by added ones is paired into "changed" rows with a word diff.
 */
export function revisionDiff(before: Revision, after: Revision): DiffSection[] {
  const sections: DiffSection[] = [];
  for (const change of claimChanges(before.sections, after.sections, SectionKey.options)) {
    const key = change.section as SectionKey;
    const title = key === "lead" ? "Lead" : SECTION_TITLES[key];
    let section = sections.at(-1);
    if (section?.title !== title) {
      section = { title, rows: [] };
      sections.push(section);
    }
    const html =
      change.kind === "changed"
        ? wordDiffHtml(change.before ?? "", change.after ?? "")
        : escapeHtml((change.kind === "removed" ? change.before : change.after) ?? "");
    section.rows.push({ kind: change.kind, html });
  }
  return sections;
}
