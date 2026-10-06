import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { plainClaimText } from "@repowiki/core";
import { RUN_INFO_FILE, readRecords, readRunInfo, summarize, tallySheet } from "@repowiki/eval";
import { cut, handleClaim, markdownText, oneLine, type WikiView } from "@repowiki/query";
import type { AskEvalResult } from "./ask-eval-run.ts";

/** Sentences the owner's blind support check reads (spec v2 #4 §12.3). */
export const SUPPORT_SAMPLE = 20;
/** §12.3: 18 of 20 supported; §12.4: 16 of 20 routed to the right page, as shares. */
export const SUPPORT_PERCENT = 90;
export const ROUTING_PERCENT = 80;
/** §12.2: the ask's accuracy at least 90% of the wiki agent's on the same questions. */
export const ACCURACY_PERCENT = 90;

const ROUTING_HEADING = "## Routing";

/** The file beside support.md that records the entries it was written with. */
export const SUPPORT_ENTRIES_FILE = "support-entries.json";

/** The entry ids a support sheet was written with, section by section. */
export interface SheetEntries {
  support: string[];
  routing: string[];
}

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
 * them; every text is plain one-line markdown. `entries` are the ids it was written with, which
 * ask:eval records beside it so the tally measures against them.
 */
export function supportSheet(
  view: WikiView,
  result: AskEvalResult,
  at: { repo: string; head: string; startedAt: string },
): { text: string; entries: SheetEntries } {
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
      return `- [ ] \`${supportId(i)}\` (sentence): ${markdownText(sentence.text, 400)} \u2014 cites ${cites}`;
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
  return {
    text: `${lines.join("\n")}\n`,
    entries: {
      support: sampled.map((_, i) => supportId(i)),
      routing: result.rows.map((row) => `routing/${row.id}`),
    },
  };
}

const supportId = (i: number) => `support/s${String(i + 1).padStart(2, "0")}`;

/** The entry ids a section of a sheet lists, in order. */
const entryIds = (part: string): string[] =>
  part
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .flatMap((line) => /^- \[[^\]]*\] `([^`]+)`/.exec(line)?.[1] ?? []);

/** Refuses a section whose entries are not the ones it was written with, on one line. */
function checkEntries(name: string, part: string, written: readonly string[]): void {
  const found = entryIds(part);
  const missing = written.filter((id) => !found.includes(id));
  const extra = found.filter((id) => !written.includes(id));
  if (missing.length === 0 && extra.length === 0 && found.length === written.length) return;
  const named = (ids: string[]) =>
    `${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ` and ${ids.length - 5} more` : ""}`;
  const why = [
    ...(missing.length > 0 ? [`missing ${named(missing)}`] : []),
    ...(extra.length > 0 ? [`not written: ${named(extra)}`] : []),
  ].join("; ");
  throw new Error(
    `the ${name} section has ${found.length} entries, but the sheet was written with ${written.length}${why === "" ? "" : ` (${why})`}`,
  );
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
 * any other mark-like line an error naming it), its Support and Routing sections apart, each
 * measured against the entries the sheet was written with (`written`: 20 support sentences and
 * 20 questions on a full dev run). A section with an entry missing or one it was not written
 * with is refused, so a trimmed sheet cannot pass on a smaller bar.
 */
export function tallySupport(
  text: string,
  written: SheetEntries,
): { support: SheetCount; routing: SheetCount } {
  // An editor may have saved the sheet with CRLF line ends.
  const at = text.search(new RegExp(`\\r?\\n${ROUTING_HEADING}\\r?\\n`));
  if (at < 0)
    throw new Error(`no "${ROUTING_HEADING}" section: is this an ask:eval support sheet?`);
  const count = (
    name: string,
    part: string,
    entries: readonly string[],
    percent: number,
  ): SheetCount => {
    const tally = tallySheet(part);
    checkEntries(name, part, entries);
    const lines = entries.length;
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
    support: count("Support", text.slice(0, at), written.support, SUPPORT_PERCENT),
    routing: count("Routing", text.slice(at), written.routing, ROUTING_PERCENT),
  };
}

/** Reads the entries recorded beside a support sheet, or throws one line saying why not. */
export function readSheetEntries(text: string): SheetEntries {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${SUPPORT_ENTRIES_FILE} is not JSON`);
  }
  const ids = (value: unknown) =>
    Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
  const record = (json ?? {}) as Record<string, unknown>;
  const support = ids(record.support);
  const routing = ids(record.routing);
  if (support === null || routing === null) {
    throw new Error(
      `${SUPPORT_ENTRIES_FILE} does not list the sheet's support and routing entries`,
    );
  }
  return { support, routing };
}

/** The owner's latest complete dev run of the eval with the wiki agent on this question file. */
export interface DevBaseline {
  runDir: string;
  wikiCorrect: number;
  questions: number;
  /** When that run started, and the wiki commit it asked. */
  startedAt: string;
  head: string;
}

/**
 * The run spec v2 #4 §12.2 compares against: the latest complete `eval:run --set dev` under
 * `<out>/eval/` that asked the wiki agent the same question file (same hash), or null. A run is a
 * folder with a run.json, whatever its name (`--run-dir`); a folder without one (ask:eval's own)
 * is not a run, and one whose run or records cannot be read is skipped with one line through
 * `onSkip`. Latest by the instant it started (Date.parse, so an offset compares right), ties by
 * directory.
 */
export function devBaseline(
  out: string,
  questionsHash: string,
  onSkip: (line: string) => void = () => {},
): DevBaseline | null {
  const dir = join(out, "eval");
  if (!existsSync(dir)) return null;
  let best: (DevBaseline & { started: number }) | null = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const runDir = join(dir, entry.name);
    if (!entry.isDirectory() || !existsSync(join(runDir, RUN_INFO_FILE))) continue;
    try {
      const info = readRunInfo(runDir);
      if (info.set !== "dev" || info.questionsHash !== questionsHash) continue;
      if (!info.agents.includes("wiki")) continue;
      const summary = summarize(info, readRecords(runDir));
      if (!summary.complete) continue;
      const started = Date.parse(info.startedAt);
      if (
        best === null ||
        started > best.started ||
        (started === best.started && runDir > best.runDir)
      ) {
        best = {
          runDir,
          wikiCorrect: summary.agents.wiki.correct,
          questions: info.questions.length,
          startedAt: info.startedAt,
          head: info.head,
          started,
        };
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      onSkip(`skipped ${runDir}: ${cut(oneLine(why), 300)}`);
    }
  }
  if (best === null) return null;
  const { started: _started, ...baseline } = best;
  return baseline;
}

/**
 * What ask:eval does about its baseline before any paid call (spec v2 #4 §12.2): the dev set
 * names the run it compares with, or with none stops in one line (exit 1) unless --no-baseline
 * (`required` false) lets it go on; a dry run with none still shows its estimate, says the run
 * would stop, and exits 0. The smoke set scores nothing, so it never needs one.
 */
export function baselineGate(at: {
  set: "dev" | "smoke";
  required: boolean;
  dryRun: boolean;
  baseline: DevBaseline | null;
  evalDir: string;
}): { line: string | null; stop: boolean; exitCode: 0 | 1 } {
  if (at.set === "smoke") return { line: null, stop: false, exitCode: 0 };
  if (at.baseline !== null) {
    return {
      line: `comparing with ${at.baseline.runDir} (started ${at.baseline.startedAt}, the wiki at ${at.baseline.head.slice(0, 7)})`,
      stop: false,
      exitCode: 0,
    };
  }
  if (!at.required) return { line: null, stop: false, exitCode: 0 };
  const why = `no complete \`eval:run --set dev\` run on this question file is in ${at.evalDir}; run \`pnpm eval:run <repo> --questions <file> --set dev\` first, or pass --no-baseline`;
  return at.dryRun
    ? { line: `no baseline yet: the run would stop; ${why}`, stop: true, exitCode: 0 }
    : { line: why, stop: true, exitCode: 1 };
}

/** Spec v2 #4 §12.2-4's lines for report.md: the accuracy comparison and the owner's checks. */
export function criteriaLines(
  result: AskEvalResult,
  baseline: DevBaseline | null,
  at: { set: "dev" | "smoke"; head: string },
): string[] {
  const correct = result.rows.filter((r) => r.score === 1).length;
  const n = result.rows.length;
  const commits =
    baseline === null || baseline.head === at.head
      ? ""
      : ` That run asked the wiki at ${baseline.head.slice(0, 7)}; this one at ${at.head.slice(0, 7)}.`;
  const accuracy =
    at.set === "smoke"
      ? "not compared: the smoke set scores nothing."
      : baseline === null
        ? "no complete `eval:run --set dev` run on this question file is in the out dir's eval/ folder, so this cannot be scored yet; run `pnpm eval:run <repo> --questions <file> --set dev` first."
        : baseline.wikiCorrect === 0
          ? `cannot be scored: the wiki agent got none right in ${markdownText(baseline.runDir, 300)}, so there is no score to reach.`
          : baseline.questions !== n
            ? `the run compared against (${markdownText(baseline.runDir, 300)}) asked ${baseline.questions} questions and this one ${n}, so they cannot be compared.`
            : `the ask got ${correct} of ${n} and the wiki agent ${baseline.wikiCorrect} of ${baseline.questions} in ${markdownText(baseline.runDir, 300)}: ${correct * 100 >= baseline.wikiCorrect * ACCURACY_PERCENT ? "met" : "not met"} (at least ${ACCURACY_PERCENT}% of the wiki agent's).${commits}`;
  return [
    "",
    "## Accuracy, grounding and routing (spec v2 #4 \u00A712.2-4)",
    "",
    `- Accuracy against the wiki agent: ${accuracy}`,
    `- Support and routing: the owner marks support.md in this folder, then runs \`pnpm ask:eval tally <support.md>\` (passes at ${SUPPORT_PERCENT}% supported and ${ROUTING_PERCENT}% routed).`,
  ];
}
