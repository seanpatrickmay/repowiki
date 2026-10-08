import type { LedgerEntry, TokenUsage } from "@repowiki/core";
import {
  DEFAULT_ARCHITECTURE_BUDGET_TOKENS,
  markdownCodeSpan,
  pullRequestOf,
  type ReplayStep,
} from "@repowiki/engine";
import { z } from "zod";
import { estimateUpdate } from "./update-cli.ts";
import { architectureSkipWhy, problemLine, WIKI_BUILD_RUN_PREFIX } from "./wiki-cli.ts";

/** Every token a run used, cached or not: the measure of spec §8's third replay invariant. */
export const tokensOf = (t: TokenUsage): number => t.in + t.out + t.cacheRead + t.cacheWrite;

/**
 * The tokens of the newest wiki:build run in `ledger` (in ledger order), or null when it holds
 * none. The ledger tags both wiki:build and manifest:build calls `kind: "build"`; a wiki:build run
 * is the one whose `runId` starts with WIKI_BUILD_RUN_PREFIX, since a manifest:build is no full
 * build. A run is its `runId`: two builds at one sha are two runs, and only the later one is the
 * "full build" an update is compared against (spec §8's third invariant), never their sum.
 */
export function newestBuildTokens(ledger: readonly LedgerEntry[]): number | null {
  const builds = ledger.filter(
    (e) => e.runKind === "build" && e.runId.startsWith(WIKI_BUILD_RUN_PREFIX),
  );
  const newest = builds.at(-1);
  if (newest === undefined) return null;
  return builds.filter((e) => e.runId === newest.runId).reduce((n, e) => n + tokensOf(e.tokens), 0);
}

/** The longest commit subject a summary row shows. */
const MAX_SUBJECT = 60;

/** A commit subject as a summary cell: printable, cut short, pipes escaped, in a code span. */
const subjectCell = (subject: string): string =>
  markdownCodeSpan(
    subject
      .slice(0, MAX_SUBJECT)
      .replace(/[^\x20-\x7e]/g, "?")
      .replace(/\|/g, "/"),
  );

/** What one replay step did, for the replay summary. */
export interface StepRecord {
  step: ReplayStep;
  stored: number;
  carried: number;
  staleClaims: number;
  /** All tokens of the step's ledger run, and its cost. */
  tokens: number;
  usd: number;
  /** checkWiki's problems after the step (spec §8 invariants 1 and 2). */
  problems: number;
  /** The step's `WikiUpdate.failures`, `refused` and `architectureSkipped`, shown as the update summary shows them. */
  failures: readonly { featureId: string; failure: string }[];
  refused: readonly { featureId: string; why: string }[];
  architectureSkipped: "too few pages" | "current" | null;
  /** The step's place in the full step list (1-based); absent when the list does not hold it. */
  position?: number;
  /**
   * Set when an earlier run stored the step and stopped before recording it: the resumed replay
   * checked it and measured its tokens from the ledger, but its update's counts are unknown.
   */
  recovered?: boolean;
}

/** Where a run stopped, and why: the summary says so, so a stop is never mistaken for a finish. */
export interface StoppedAt {
  position: number;
  sha: string;
  reason: string;
}

const StepRecordFile = z.object({
  version: z.literal(1),
  records: z.array(
    z.object({
      step: z.object({ sha: z.string(), subject: z.string(), merge: z.boolean() }),
      stored: z.number(),
      carried: z.number(),
      staleClaims: z.number(),
      tokens: z.number(),
      usd: z.number(),
      problems: z.number(),
      failures: z.array(z.object({ featureId: z.string(), failure: z.string() })),
      refused: z.array(z.object({ featureId: z.string(), why: z.string() })),
      architectureSkipped: z.enum(["too few pages", "current"]).nullable(),
      position: z.number().optional(),
      recovered: z.boolean().optional(),
    }),
  ),
});

/** The records as saved beside the replay summary, so a later run renders every run's steps. */
export const renderStepRecords = (records: readonly StepRecord[]): string =>
  `${JSON.stringify({ version: 1, records }, null, 2)}\n`;

/** The saved records, or an Error naming the file as not a replay record. */
export function parseStepRecords(text: string): StepRecord[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("not a replay record: it is not JSON");
  }
  const parsed = StepRecordFile.safeParse(json);
  if (!parsed.success) throw new Error("not a replay record: it does not hold step records");
  return parsed.data.records;
}

/**
 * Spec §8's invariants over every record: no step left a problem (invariants 1 and 2), and none
 * cost as many tokens as the last full build (3), when there is a build to compare with.
 */
export const invariantsHold = (
  records: readonly StepRecord[],
  buildTokens: number | null,
): boolean =>
  records.every((r) => r.problems === 0) &&
  (buildTokens === null || records.every((r) => r.tokens < buildTokens));

/** A step the dry run plans: how many files it changes and pages it may touch, and their cost. */
export interface StepProjection {
  step: ReplayStep;
  files: number;
  pages: number;
  usd: number;
}

/**
 * A step's cost before any call, from its diff alone (the store cannot be moved by a dry run):
 * every active feature with a changed member file is taken as one update call with a full pack
 * (`budgetTokens`), plus the About article at its own budget when any page may change, and one
 * tie-break call when
 * the step adds files. Upper-side for those calls only: it omits a drift call, whole pages and the
 * retry round. The live run states
 * each step's own estimate from the real plan before its calls.
 */
export function projectStep(
  input: {
    step: ReplayStep;
    files: number;
    pages: number;
    articleDue?: boolean;
    /** The step adds files, any of which may need a tie-break call. */
    addsFiles?: boolean;
  },
  prompts: { update: string; article: string },
  budgetTokens: number,
  model: string,
  batch: boolean,
): StepProjection {
  // The write role is called for pages, and the tie-break role for a step that adds files (one
  // call, whether or not their signals disagree: the dry run does not index the step); a
  // projected step makes no drift call.
  const models = { tieBreak: model, manifest: model, write: model };
  const estimate = estimateUpdate(
    {
      rewrites: Array.from({ length: input.pages }, () => ({ tokens: budgetTokens })),
      updateSystem: prompts.update,
      whole: [],
      writeSystem: "",
      disputed: input.addsFiles === true,
      drifted: false,
      // The article is rewritten when a page may change, or already due as the store stands.
      // The article's pack has its own budget, as wiki:update's article call does.
      article:
        input.pages > 0 || input.articleDue === true
          ? { system: prompts.article, budgetTokens: DEFAULT_ARCHITECTURE_BUDGET_TOKENS }
          : null,
    },
    models,
    batch,
  );
  return {
    step: input.step,
    files: input.files,
    pages: input.pages,
    usd: estimate.usd + (estimate.articleUsd ?? 0),
  };
}

/** The dry run's table: one row per planned step, then the total. */
export function renderProjection(projections: readonly StepProjection[], left: number): string {
  const total = projections.reduce((n, p) => n + p.usd, 0);
  return [
    "| Step | Commit | PR | Subject | Files | Pages | Estimate |",
    "|---:|---|---:|---|---:|---:|---:|",
    ...projections.map(
      (p, i) =>
        `| ${i + 1} | ${p.step.sha.slice(0, 7)} | ${pullRequestOf(p.step.subject) ?? ""} | ${subjectCell(p.step.subject)} | ${p.files} | ${p.pages} | $${p.usd.toFixed(4)} |`,
    ),
    "",
    `${projections.length} steps estimated at about $${total.toFixed(4)}${left > 0 ? `; ${left} more steps after them are left for a later run` : ""}.`,
    "Upper-side for the update and tie-break calls only: drift, whole-page and retry calls are not counted.",
  ].join("\n");
}

/**
 * What a step's update summary says in its table about failed whole pages, refused rewrites and
 * the article's skip reason, as one line under the replay table; null when it had none of them.
 */
function stepNote(index: number, r: StepRecord): string | null {
  const code = (text: string): string => markdownCodeSpan(problemLine(text));
  const parts = [
    ...(r.recovered === true
      ? ["stored by a run that stopped before recording it; checked when the replay resumed"]
      : []),
    ...(r.failures.length === 0
      ? []
      : [
          `${r.failures.length} whole ${r.failures.length === 1 ? "page" : "pages"} could not be written: ${r.failures.map((f) => `${code(f.featureId)} (${code(f.failure)})`).join(", ")}`,
        ]),
    ...(r.refused.length === 0
      ? []
      : [
          `not updated: ${r.refused.map((f) => `${code(f.featureId)} (${code(f.why === "nothing changed" ? "unchanged" : f.why)})`).join(", ")}`,
        ]),
    ...(r.architectureSkipped === null
      ? []
      : [`About article: ${architectureSkipWhy(r.architectureSkipped)}`]),
  ];
  return parts.length === 0
    ? null
    : `- Step ${r.position ?? index + 1} (${r.step.sha.slice(0, 7)}): ${parts.join("; ")}.`;
}

/** `lines` without the blank lines at their end. */
const withoutTrailingBlanks = (lines: readonly string[]): string[] => {
  const out = [...lines];
  while (out.at(-1) === "") out.pop();
  return out;
};

/**
 * The replay summary saved as replay-<from7>-<to7>.md after every step, so a killed replay
 * leaves its record: one row per step with spec §8's invariants (no problems after it, and fewer
 * tokens than the last full build), then the totals. `records` holds every run's steps, each
 * numbered by its `position` in the full list, and `stopped` says where a run stopped. `people`
 * is the People step's summary section, last; empty (and the summary v1's) when People is off.
 */
export function renderReplaySummary(
  repoName: string,
  from: string,
  to: string,
  records: readonly StepRecord[],
  left: number,
  buildTokens: number | null,
  stopped: StoppedAt | null = null,
  people: readonly string[] = [],
): string {
  // Spec §8's third invariant ("every update costs fewer tokens than the last full build") is
  // compared here, in `under` and `holds`, against `buildTokens`: the newest build run's own
  // tokens (see newestBuildTokens), or null when the ledger holds none, in which case the
  // invariant was not checked and the verdict says so rather than claiming it holds.
  const under = (tokens: number) =>
    buildTokens === null ? "n/a" : tokens < buildTokens ? "yes" : "**no**";
  const usd = records.reduce((n, r) => n + r.usd, 0);
  const holds = invariantsHold(records, buildTokens);
  const verdict = !holds
    ? "**broken**; see the rows above and pnpm wiki:check"
    : records.length === 0
      ? "no step has been replayed"
      : buildTokens === null
        ? "no step left a problem; token invariant not checked (no build run in the ledger)"
        : stopped === null
          ? "hold for every step"
          : "hold for every step replayed; the replay then stopped";
  const notes = records.flatMap((r, i) => stepNote(i, r) ?? []);
  const count = (n: number | undefined, r: StepRecord): string =>
    r.recovered === true ? "n/a" : String(n);
  return `${[
    `# Replay: ${markdownCodeSpan(repoName)} ${from.slice(0, 7)} → ${to.slice(0, 7)}`,
    "",
    `${records.length} steps replayed${left > 0 ? `, ${left} left` : ""}; ${buildTokens === null ? "the ledger holds no build run to compare them with" : `the newest full build used ${buildTokens.toLocaleString("en-US")} tokens`}.`,
    "",
    "| Step | Commit | PR | Subject | Stored | Carried | Stale | Tokens | Cost | Problems | Under build |",
    "|---:|---|---:|---|---:|---:|---:|---:|---:|---:|---|",
    ...records.map(
      (r, i) =>
        `| ${r.position ?? i + 1} | ${r.step.sha.slice(0, 7)} | ${pullRequestOf(r.step.subject) ?? ""} | ${subjectCell(r.step.subject)} | ${count(r.stored, r)} | ${count(r.carried, r)} | ${count(r.staleClaims, r)} | ${r.tokens.toLocaleString("en-US")} | $${r.usd.toFixed(4)} | ${r.problems} | ${under(r.tokens)} |`,
    ),
    ...(notes.length === 0 ? [] : ["", "## Step notes", "", ...notes]),
    ...(stopped === null
      ? []
      : [
          "",
          `Stopped at step ${stopped.position} (${stopped.sha.slice(0, 7)}): ${markdownCodeSpan(problemLine(stopped.reason))}.`,
        ]),
    "",
    `Invariants: ${verdict}.`,
    "",
    `Cost: $${usd.toFixed(4)}.`,
    ...(people.length === 0 ? [] : ["", ...withoutTrailingBlanks(people)]),
  ].join("\n")}\n`;
}
