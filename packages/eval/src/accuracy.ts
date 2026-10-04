import {
  type Citation,
  CLAIM_TEXT_MAX_LENGTH,
  plainClaimText,
  type WikiExport,
} from "@repowiki/core";
import { markdownText } from "./text.ts";
import { SECTION_TITLES } from "./wiki-page.ts";

/** Spec §9's second exit criterion: at most 1 false claim per 50 claims reviewed. */
export const CLAIMS_PER_FALSE_CLAIM = 50;

function reference(c: Citation): string {
  return c.kind === "code"
    ? `${markdownText(c.path, 200)}:${c.startLine}-${c.endLine}@${c.sha.slice(0, 7)}`
    : `commit ${c.sha.slice(0, 7)}`;
}

/**
 * A claim id as the sheet's code span shows it: the export does not constrain claim ids, so any
 * character but a letter, a digit, `.`, `_` or `-` becomes `?`, and no id can close the span or
 * start a line the tally would count.
 */
const shownId = (id: string) => [...id.replace(/[^A-Za-z0-9._-]/g, "?")].slice(0, 64).join("");

/**
 * The accuracy review's sheet (spec §9): every claim of the named pages (each page once), one
 * checkbox line each with its section and references, for the author to mark true or false. With
 * no ids it lists every active page. Titles, claim text and paths are written as plain one-line
 * markdown text (markdownText), claims in full.
 */
export function accuracySheet(wiki: WikiExport, featureIds: readonly string[]): string {
  const features = new Map(wiki.manifest.features.map((f) => [f.id, f]));
  const pages = new Map(wiki.pages.map((p) => [p.featureId, p]));
  const ids =
    featureIds.length > 0
      ? [...new Set(featureIds)]
      : wiki.pages
          .filter((p) => features.get(p.featureId)?.status.kind === "active")
          .map((p) => p.featureId);
  const lines = [
    `# Accuracy review: ${markdownText(wiki.repo, 80)} at ${wiki.head.slice(0, 7)}`,
    "",
    "Read each claim against its references at the commit shown, then mark its box: `[x]` when the claim is true, `[!]` when it is false (and file an issue with the accuracy template). Leave `[ ]` on a claim you did not review. Then run `pnpm eval:accuracy tally <this file>`.",
    "",
    `Spec \u00A79 passes when at most 1 claim in ${CLAIMS_PER_FALSE_CLAIM} reviewed is false.`,
  ];
  for (const id of ids) {
    const page = pages.get(id);
    if (page === undefined) continue;
    lines.push("", `## ${markdownText(features.get(id)?.title ?? id, 120)} (${id})`, "");
    for (const section of page.sections) {
      for (const claim of section.claims) {
        const plain = plainClaimText(claim.text, (to) => features.get(to)?.title ?? null);
        const text = markdownText(plain, CLAIM_TEXT_MAX_LENGTH);
        const refs = claim.citations.map(reference).join("; ");
        lines.push(
          `- [ ] \`${id}/${shownId(claim.id)}\` (${SECTION_TITLES[section.key] ?? section.key}): ${text}${refs === "" ? "" : ` (${refs})`}`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface AccuracyTally {
  /** Claims marked true or false. */
  reviewed: number;
  false: number;
  unmarked: number;
  /** Ids of the claims marked false, for the issues. */
  falseClaims: string[];
  pass: boolean;
}

/** A claim line as the sheet writes it, with any one-character mark. */
const CLAIM_LINE = /^- \[(.)\] `([^`]+)` \(/;
/** Any line that looks like a checkbox: a mark the tally must read, or refuse. */
const MARK_LIKE = /^\s*[-*+]\s*\[/;

/**
 * Counts a marked sheet: `[x]` true, `[!]` false, `[ ]` not reviewed. Any other mark, any line
 * that looks like a mark but is not a claim line as the sheet wrote it, and a claim listed twice
 * are errors naming the line: a mark is never skipped. A byte-order mark and CRLF ends are read.
 */
export function tallySheet(text: string): AccuracyTally {
  const tally: AccuracyTally = { reviewed: 0, false: 0, unmarked: 0, falseClaims: [], pass: false };
  const seen = new Set<string>();
  text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!MARK_LIKE.test(line)) return;
      const match = CLAIM_LINE.exec(line);
      if (match === null) {
        throw new Error(
          `line ${i + 1}: not a claim line as the sheet wrote it; change only the mark between [ and ]`,
        );
      }
      const [, mark, id = ""] = match;
      if (seen.has(id)) throw new Error(`line ${i + 1}: claim ${id} is listed twice`);
      seen.add(id);
      if (mark === " ") tally.unmarked++;
      else if (mark === "x" || mark === "X") tally.reviewed++;
      else if (mark === "!") {
        tally.reviewed++;
        tally.false++;
        tally.falseClaims.push(id);
      } else throw new Error(`line ${i + 1}: mark a claim [x], [!] or [ ], not [${mark}]`);
    });
  tally.pass = tally.reviewed > 0 && tally.false * CLAIMS_PER_FALSE_CLAIM <= tally.reviewed;
  return tally;
}
