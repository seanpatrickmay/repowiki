import type { TokenUsage } from "@repowiki/core";
import { markdownCodeSpan, pullRequestOf, type ReplayStep } from "@repowiki/engine";
import { estimateUpdate } from "./update-cli.ts";
import { architectureSkipWhy } from "./wiki-cli.ts";

/** Every token a run used, cached or not: the measure of spec §8's third replay invariant. */
export const tokensOf = (t: TokenUsage): number => t.in + t.out + t.cacheRead + t.cacheWrite;

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
}

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
 * (`budgetTokens`), plus the About article when any page may change. An upper-side figure; the
 * live run states each step's own estimate from the real plan before its calls.
 */
export function projectStep(
  input: { step: ReplayStep; files: number; pages: number },
  prompts: { update: string; article: string },
  budgetTokens: number,
  model: string,
  batch: boolean,
): StepProjection {
  // Only the write role is called: a projected step makes no tie-break or drift call.
  const models = { tieBreak: model, manifest: model, write: model };
  const estimate = estimateUpdate(
    {
      rewrites: Array.from({ length: input.pages }, () => ({ tokens: budgetTokens })),
      updateSystem: prompts.update,
      whole: [],
      writeSystem: "",
      disputed: false,
      drifted: false,
      article: input.pages > 0 ? { system: prompts.article, budgetTokens } : null,
    },
    models,
    batch,
  );
  return { ...input, usd: estimate.usd + (estimate.articleUsd ?? 0) };
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
    `${projections.length} steps estimated at $${total.toFixed(4)} at most${left > 0 ? `; ${left} more steps after them are left for a later run` : ""}.`,
  ].join("\n");
}

/**
 * What a step's update summary says in its table about failed whole pages, refused rewrites and
 * the article's skip reason, as one line under the replay table; null when it had none of them.
 */
function stepNote(index: number, r: StepRecord): string | null {
  const parts = [
    ...(r.failures.length === 0
      ? []
      : [
          `${r.failures.length} whole ${r.failures.length === 1 ? "page" : "pages"} could not be written: ${r.failures.map((f) => `${markdownCodeSpan(f.featureId)} (${markdownCodeSpan(f.failure)})`).join(", ")}`,
        ]),
    ...(r.refused.length === 0
      ? []
      : [
          `not updated: ${r.refused.map((f) => `${markdownCodeSpan(f.featureId)} (${markdownCodeSpan(f.why === "nothing changed" ? "unchanged" : f.why)})`).join(", ")}`,
        ]),
    ...(r.architectureSkipped === null
      ? []
      : [`About article: ${architectureSkipWhy(r.architectureSkipped)}`]),
  ];
  return parts.length === 0
    ? null
    : `- Step ${index + 1} (${r.step.sha.slice(0, 7)}): ${parts.join("; ")}.`;
}

/**
 * The replay summary saved as replay-<from7>-<to7>.md after every step, so a killed replay
 * leaves its record: one row per step with spec §8's invariants (no problems after it, and fewer
 * tokens than the last full build), then the totals.
 */
export function renderReplaySummary(
  repoName: string,
  from: string,
  to: string,
  records: readonly StepRecord[],
  left: number,
  buildTokens: number | null,
): string {
  // The comparison for spec §8's third invariant ("every update costs fewer tokens than the last
  // full build") is made here, in `under` and `holds`, against `buildTokens`. The caller takes
  // that from `runTotals`, which keys runs by kind and sha and ignores `runId`, so two builds at
  // one sha are summed into one total: `buildTokens` can overstate the last build, and the
  // comparison is then more lenient than the invariant.
  const under = (tokens: number) =>
    buildTokens === null ? "n/a" : tokens < buildTokens ? "yes" : "**no**";
  const usd = records.reduce((n, r) => n + r.usd, 0);
  const holds =
    records.every((r) => r.problems === 0) &&
    (buildTokens === null || records.every((r) => r.tokens < buildTokens));
  const notes = records.flatMap((r, i) => stepNote(i, r) ?? []);
  return `${[
    `# Replay: ${markdownCodeSpan(repoName)} ${from.slice(0, 7)} → ${to.slice(0, 7)}`,
    "",
    `${records.length} steps replayed${left > 0 ? `, ${left} left` : ""}; the last full build used ${buildTokens === null ? "an unknown number of" : buildTokens.toLocaleString("en-US")} tokens.`,
    "",
    "| Step | Commit | PR | Subject | Stored | Carried | Stale | Tokens | Cost | Problems | Under build |",
    "|---:|---|---:|---|---:|---:|---:|---:|---:|---:|---|",
    ...records.map(
      (r, i) =>
        `| ${i + 1} | ${r.step.sha.slice(0, 7)} | ${pullRequestOf(r.step.subject) ?? ""} | ${subjectCell(r.step.subject)} | ${r.stored} | ${r.carried} | ${r.staleClaims} | ${r.tokens.toLocaleString("en-US")} | $${r.usd.toFixed(4)} | ${r.problems} | ${under(r.tokens)} |`,
    ),
    ...(notes.length === 0 ? [] : ["", "## Step notes", "", ...notes]),
    "",
    `Invariants: ${holds ? "hold for every step" : "**broken**; see the rows above and pnpm wiki:check"}.`,
    "",
    `Cost: $${usd.toFixed(4)}.`,
  ].join("\n")}\n`;
}
