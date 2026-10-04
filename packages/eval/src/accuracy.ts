import type { Citation, WikiExport } from "@repowiki/core";
import { cut, oneLine } from "./text.ts";

/** Spec §9's second exit criterion: at most 1 false claim per 50 claims reviewed. */
export const CLAIMS_PER_FALSE_CLAIM = 50;

const SECTION_TITLES: Readonly<Record<string, string>> = {
  lead: "Lead",
  overview: "Overview",
  "how-it-works": "How it works",
  "data-flow": "Data flow",
  history: "History",
  "known-limitations": "Known limitations",
};

const LINK = /\[\[(?:wp:)?([^\]|]+)(?:\|([^\]]+))?\]\]/g;

function reference(c: Citation): string {
  return c.kind === "code"
    ? `${oneLine(c.path)}:${c.startLine}-${c.endLine}@${c.sha.slice(0, 7)}`
    : `commit ${c.sha.slice(0, 7)}`;
}

/**
 * The accuracy review's sheet (spec §9): every claim of the named pages, one checkbox line each
 * with its section and references, for the author to mark true or false. With no ids it lists
 * every active page.
 */
export function accuracySheet(wiki: WikiExport, featureIds: readonly string[]): string {
  const features = new Map(wiki.manifest.features.map((f) => [f.id, f]));
  const pages = new Map(wiki.pages.map((p) => [p.featureId, p]));
  const ids =
    featureIds.length > 0
      ? featureIds
      : wiki.pages
          .filter((p) => features.get(p.featureId)?.status.kind === "active")
          .map((p) => p.featureId);
  const lines = [
    `# Accuracy review: ${cut(oneLine(wiki.repo), 80)} at ${wiki.head.slice(0, 7)}`,
    "",
    "Read each claim against its references at the commit shown, then mark its box: `[x]` when the claim is true, `[!]` when it is false (and file an issue with the accuracy template). Leave `[ ]` on a claim you did not review. Then run `pnpm eval:accuracy tally <this file>`.",
    "",
    `Spec §9 passes when at most 1 claim in ${CLAIMS_PER_FALSE_CLAIM} reviewed is false.`,
  ];
  for (const id of ids) {
    const page = pages.get(id);
    if (page === undefined) continue;
    lines.push("", `## ${cut(oneLine(features.get(id)?.title ?? id), 120)} (${id})`, "");
    for (const section of page.sections) {
      for (const claim of section.claims) {
        const text = cut(
          oneLine(
            claim.text.replace(LINK, (_m, target: string, label?: string) => label ?? target),
          ),
          600,
        );
        const refs = claim.citations.map(reference).join("; ");
        lines.push(
          `- [ ] \`${id}/${claim.id}\` (${SECTION_TITLES[section.key] ?? section.key}): ${text}${refs === "" ? "" : ` (${refs})`}`,
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

const CLAIM_LINE = /^- \[(.)\] `([^`]+)`/;

/** Counts a marked sheet: `[x]` true, `[!]` false, `[ ]` not reviewed; any other mark is an error. */
export function tallySheet(text: string): AccuracyTally {
  const tally: AccuracyTally = { reviewed: 0, false: 0, unmarked: 0, falseClaims: [], pass: false };
  text.split("\n").forEach((line, i) => {
    const match = CLAIM_LINE.exec(line);
    if (match === null) return;
    const [, mark, id = ""] = match;
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
