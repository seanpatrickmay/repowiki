import { type ClaimChange, claimChanges, wordDiff } from "@repowiki/core";
import { cut, oneLine } from "./text.ts";
import { MAX_TOOL_RESULT_CHARS } from "./tools.ts";
import { SECTION_TITLES } from "./wiki-page.ts";
import type { WikiView } from "./wiki-view.ts";

/** A page or About article revision, as page_changes compares them. */
export interface ChangedRevision {
  sha: string;
  commitDate: string;
  reason: string;
  pr: number | null;
  sections: readonly { key: string; claims: readonly { text: string }[] }[];
}

const sha7 = (sha: string) => sha.slice(0, 7);
const date = (iso: string) => iso.slice(0, 10);

/** One revision as a list entry: "2026-01-03 commit 594d833 (update, pull request #7)". */
export const revisionEntry = (r: ChangedRevision): string =>
  `${date(r.commitDate)} commit ${sha7(r.sha)} (${r.reason}${r.pr === null ? "" : `, pull request #${r.pr}`})`;

/** A rewritten claim as words: `[-old-]{+new+}` around what changed, the rest as it was. */
export function wordDiffText(before: string, after: string): string {
  return wordDiff(before, after)
    .map(({ op, value }) =>
      op === "equal" ? value : op === "delete" ? `[-${value}-]` : `{+${value}+}`,
    )
    .join("");
}

/** One change as a line: `- removed`, `+ added`, `~ changed` (a word diff), or `  context`. */
function changeLine(view: WikiView, change: ClaimChange): string {
  const shown = (text: string | null) => view.text(text ?? "");
  switch (change.kind) {
    case "removed":
      return `- ${shown(change.before)}`;
    case "added":
      return `+ ${shown(change.after)}`;
    case "changed":
      return `~ ${oneLine(wordDiffText(shown(change.before), shown(change.after)))}`;
    case "context":
      return `  ${shown(change.after)}`;
  }
}

/**
 * page_changes (spec v2 #5 §6.2): the claim-by-claim diff between two revisions of one page, per
 * section in `keys` order, then the revisions from `from` to `to`. Fitted to `max` code points by
 * putting a count in place of unchanged claims first; claim text goes through the view's
 * neutralisation, as read_page shows it.
 */
export function renderChanges(
  view: WikiView,
  heading: string,
  from: { revision: ChangedRevision; n: number },
  to: { revision: ChangedRevision; n: number },
  between: readonly ChangedRevision[],
  keys: readonly string[],
  max = MAX_TOOL_RESULT_CHARS,
): string {
  const label = (x: { revision: ChangedRevision; n: number }) =>
    `revision ${x.n} (commit ${sha7(x.revision.sha)}, ${date(x.revision.commitDate)})`;
  const top = `${cut(oneLine(heading), 200)} from ${label(from)} to ${label(to)}:`;
  if (from.n === to.n) {
    return `${top}\nThe same revision is current at both points: nothing changed between them.\n`;
  }
  const changes = claimChanges(from.revision.sections, to.revision.sections, keys);
  const revisions = [
    "",
    "Revisions in this range, oldest first:",
    ...between.map((r) => `- ${revisionEntry(r)}`),
  ];
  const render = (withContext: boolean) => {
    const lines = [top];
    if (changes.length === 0)
      lines.push("", "No claim changed (only the infobox, See also or citations did).");
    let section: string | null = null;
    let hidden = 0;
    const flushHidden = () => {
      if (hidden > 0) lines.push(`  (${hidden} unchanged ${hidden === 1 ? "claim" : "claims"})`);
      hidden = 0;
    };
    for (const change of changes) {
      if (change.section !== section) {
        flushHidden();
        section = change.section;
        lines.push("", SECTION_TITLES[section] ?? section);
      }
      if (change.kind === "context" && !withContext) {
        hidden++;
        continue;
      }
      flushHidden();
      lines.push(changeLine(view, change));
    }
    flushHidden();
    return `${[...lines, ...revisions].join("\n")}\n`;
  };
  const whole = render(true);
  return [...whole].length <= max ? whole : render(false);
}
