import { createHash } from "node:crypto";
import { plainClaimText } from "@repowiki/core";
import { tallySheet } from "@repowiki/eval";
import { handleClaim, markdownText, type WikiView } from "@repowiki/query";
import type { AskEvalResult } from "./ask-eval-run.ts";

/** Sentences the owner's blind support check reads (spec v2 #4 §12.3). */
export const SUPPORT_SAMPLE = 20;
/** §12.3: 18 of 20 supported; §12.4: 16 of 20 routed to the right page, as shares. */
export const SUPPORT_PERCENT = 90;
export const ROUTING_PERCENT = 80;

const ROUTING_HEADING = "## Routing";

/** A cited claim as the sheet quotes it: its whole text as plain words, and where it is. */
function citedClaim(
  view: WikiView,
  source: { pageId: string; claimId: string; pageTitle: string; sectionTitle: string | null },
): string {
  const found = handleClaim(view, `${source.pageId}#${source.claimId}`);
  const text =
    found === null
      ? "(no longer in the wiki)"
      : plainClaimText(found.claim.text, (id) => (view.features.has(id) ? view.title(id) : null));
  const where =
    source.sectionTitle === null ? source.pageTitle : `${source.pageTitle}, ${source.sectionTitle}`;
  return `"${markdownText(text, 2000)}" (${markdownText(where, 200)})`;
}

/**
 * support.md (spec v2 #4 §7, §12.3-4): SUPPORT_SAMPLE sentences the ask showed, chosen in an
 * order fixed by the run's start time, each with the full text of the claims it cites and no
 * question, grade or agent, for the owner to mark; then one line per question naming the first
 * source's page, for the routing check. Lines are the M7 accuracy sheet's, so its tally reads
 * them; every text is plain one-line markdown.
 */
export function supportSheet(
  view: WikiView,
  result: AskEvalResult,
  at: { repo: string; head: string; startedAt: string },
): string {
  const pairs = result.rows.flatMap((row) =>
    row.response.status === "answered" || row.response.status === "partial"
      ? row.response.sentences.map((sentence, i) => ({ row, sentence, key: `${row.id}/${i}` }))
      : [],
  );
  const order = (key: string) =>
    createHash("sha256").update(`${at.startedAt}\0${key}`).digest("hex");
  const sampled = [...pairs]
    .sort((a, b) => (order(a.key) < order(b.key) ? -1 : 1))
    .slice(0, SUPPORT_SAMPLE);
  const lines = [
    `# Ask support sheet: ${markdownText(at.repo, 80)} at ${at.head.slice(0, 7)}`,
    "",
    "Each line below is one sentence the ask showed a reader, and the claims it cited. Mark its box `[x]` when the cited claims support the sentence and `[!]` when they do not; leave `[ ]` on a line you did not check. Then run `pnpm ask:eval tally <this file>`.",
    "",
    `Spec v2 #4 \u00A712.3 passes when at least ${SUPPORT_PERCENT}% of the sampled sentences are supported (18 of 20).`,
    "",
    "## Support",
    "",
    ...sampled.map(({ row, sentence }, i) => {
      const cites = sentence.sources
        .map((n) => row.response.sources[n - 1])
        .flatMap((s) => (s === undefined ? [] : [citedClaim(view, s)]))
        .join("; ");
      return `- [ ] \`support/s${String(i + 1).padStart(2, "0")}\` (sentence): ${markdownText(sentence.text, 400)} \u2014 cites ${cites}`;
    }),
    "",
    ROUTING_HEADING,
    "",
    `For each question, mark \`[x]\` when the first source's page is the right place to start reading, and \`[!]\` when it is not. Spec v2 #4 \u00A712.4 passes at ${ROUTING_PERCENT}% (16 of 20).`,
    "",
    ...result.rows.map((row) => {
      const first = row.response.sources[0];
      const page =
        first === undefined
          ? "no source"
          : `${markdownText(first.pageTitle, 200)} (${markdownText(first.href, 120)})`;
      return `- [ ] \`routing/${row.id}\` (question): ${markdownText(row.question, 1000)} \u2014 first source: ${page}`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

export interface SheetCount {
  /** Lines in the section. */
  lines: number;
  /** Marked `[x]`. */
  yes: number;
  /** Marked `[!]`. */
  no: number;
  unmarked: number;
  pass: boolean;
}

/**
 * Counts a marked support sheet with the M7 sheet's rules (tallySheet: `[x]`, `[!]`, `[ ]`, and
 * any other mark-like line an error naming it), its Support and Routing sections apart.
 */
export function tallySupport(text: string): { support: SheetCount; routing: SheetCount } {
  const at = text.indexOf(`\n${ROUTING_HEADING}\n`);
  if (at < 0)
    throw new Error(`no "${ROUTING_HEADING}" section: is this an ask:eval support sheet?`);
  const count = (part: string, percent: number): SheetCount => {
    const tally = tallySheet(part);
    const lines = tally.reviewed + tally.unmarked;
    const yes = tally.reviewed - tally.false;
    return {
      lines,
      yes,
      no: tally.false,
      unmarked: tally.unmarked,
      pass: lines > 0 && yes * 100 >= lines * percent,
    };
  };
  return {
    support: count(text.slice(0, at), SUPPORT_PERCENT),
    routing: count(text.slice(at), ROUTING_PERCENT),
  };
}
