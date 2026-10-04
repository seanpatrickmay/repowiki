import { estimateTokens, markdownCodeSpan, type WikiUpdate } from "@repowiki/engine";
import type { LedgerTotals } from "@repowiki/llm";
import { CliError } from "./manifest-cli.ts";
import {
  ASSUMED_PAGE_OUTPUT_TOKENS,
  architectureRow,
  cell,
  costLines,
  estimateArchitecture,
  parseRunArgs,
  priced,
  type RunFlags,
} from "./wiki-cli.ts";

const FLAGS =
  "[--out dir] [--config file.json] [--no-batch] [--dry-run] [--budget tokens] [--deadline minutes] [--verbose]";
export const UPDATE_USAGE = `usage: pnpm wiki:update <repo-path> <rev> ${FLAGS}`;
export const REPLAY_USAGE = `usage: pnpm wiki:replay <repo-path> <from-rev> <to-rev> [--limit N] ${FLAGS}`;

export interface UpdateArgs extends RunFlags {
  repo: string;
  rev: string;
}

export interface ReplayArgs extends RunFlags {
  repo: string;
  from: string;
  to: string;
  /** Replay at most this many steps this run; null replays every step left. */
  limit: number | null;
}

/** Non-empty positionals, exactly `names` of them, or a CliError naming the usage. */
function positionals(given: string[], names: readonly string[], usage: string): string[] {
  if (given.length !== names.length) throw new CliError(usage);
  given.forEach((value, i) => {
    if (value === "") throw new CliError(`${names[i]} must not be empty; ${usage}`);
  });
  return given;
}

/** `<repo> <rev>` plus wiki:build's flags in any order. */
export function parseUpdateArgs(argv: readonly string[]): UpdateArgs {
  const { positionals: given, flags } = parseRunArgs(argv, UPDATE_USAGE);
  const [repo = "", rev = ""] = positionals(given, ["<repo-path>", "<rev>"], UPDATE_USAGE);
  return { repo, rev, ...flags };
}

/** `<repo> <from> <to> [--limit N]` plus wiki:build's flags in any order. */
export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const { positionals: given, flags, limit } = parseRunArgs(argv, REPLAY_USAGE, true);
  const [repo = "", from = "", to = ""] = positionals(
    given,
    ["<repo-path>", "<from-rev>", "<to-rev>"],
    REPLAY_USAGE,
  );
  return { repo, from, to, limit, ...flags };
}

/** Output tokens an update call is assumed to take: it returns only the claims it rewrites. */
export const ASSUMED_UPDATE_OUTPUT_TOKENS = 1500;
/** A tie-break or drift call, assumed: a cluster or file listing in, a short answer out. */
export const ASSUMED_SMALL_CALL = { input: 8000, output: 1000 };

export interface UpdateEstimate {
  rewrites: number;
  whole: number;
  /** Tie-break and drift calls (0, 1 or 2). */
  small: number;
  inputTokens: number;
  outputTokens: number;
  /** First round of every call, no cache hits; a retry round adds at most about as much again. */
  usd: number;
  /** The About article's upper-side estimate when a rewrite could change a lead; else null. */
  articleUsd: number | null;
}

export interface UpdateEstimateInput {
  /** The update calls' packs, and their shared system prompt. */
  rewrites: readonly { tokens: number }[];
  updateSystem: string;
  /** Whole pages' packs (features without a page), and the write system prompt. */
  whole: readonly { tokens: number }[];
  writeSystem: string;
  /** Whether a tie-break and a drift call will be made. */
  disputed: boolean;
  drifted: boolean;
  /** The article's system prompt and pack budget when its rewrite is possible, else null. */
  article: { system: string; budgetTokens: number } | null;
}

/**
 * An update's cost, stated before any call (owner directive), the way wiki:build states a
 * build's: every call's prefix and pack priced at the model's rates, halved when batched, with
 * assumed answer sizes. Pages the drift call's operations change are not known yet: they are
 * written whole at about a build page's cost each.
 */
export function estimateUpdate(
  input: UpdateEstimateInput,
  model: string,
  batch: boolean,
): UpdateEstimate {
  const updatePrefix = estimateTokens(input.updateSystem);
  const writePrefix = estimateTokens(input.writeSystem);
  const small = (input.disputed ? 1 : 0) + (input.drifted ? 1 : 0);
  const inputTokens =
    input.rewrites.reduce((n, p) => n + p.tokens + updatePrefix, 0) +
    input.whole.reduce((n, p) => n + p.tokens + writePrefix, 0) +
    small * ASSUMED_SMALL_CALL.input;
  const outputTokens =
    input.rewrites.length * ASSUMED_UPDATE_OUTPUT_TOKENS +
    input.whole.length * ASSUMED_PAGE_OUTPUT_TOKENS +
    small * ASSUMED_SMALL_CALL.output;
  const article =
    input.article === null
      ? null
      : estimateArchitecture(input.article.system, input.article.budgetTokens, model, batch);
  return {
    rewrites: input.rewrites.length,
    whole: input.whole.length,
    small,
    inputTokens,
    outputTokens,
    usd: priced(model, inputTokens, outputTokens, batch),
    articleUsd: article?.usd ?? null,
  };
}

/** The one line a dry run and a live run print before any call. */
export function estimateLine(estimate: UpdateEstimate, batch: boolean): string {
  const article =
    estimate.articleUsd === null
      ? ""
      : `, plus at most $${estimate.articleUsd.toFixed(4)} if the About article is due`;
  return `${estimate.rewrites} pages to update, ${estimate.whole} to write whole, ${estimate.small} small calls: about ${estimate.inputTokens.toLocaleString("en-US")} input tokens, estimated at $${estimate.usd.toFixed(4)}${batch ? " (batched)" : ""}${article}`;
}

const claimsOf = (r: { sections: { claims: unknown[] }[] }): number =>
  r.sections.reduce((n, s) => n + s.claims.length, 0);

/** The update summary saved for the owner as update-<sha7>.md. */
export function renderUpdateSummary(
  repoName: string,
  update: WikiUpdate,
  estimate: UpdateEstimate | null,
  totals: LedgerTotals,
): string {
  const pr = update.pr === null ? "no PR" : `PR #${update.pr}`;
  const drift =
    update.drift === null
      ? "no feature drifted"
      : update.drift.revised
        ? `drift: ${update.drift.operations.length} manifest operations applied`
        : "drift: the operations were refused twice; the next update asks again";
  const upFront =
    estimate === null
      ? "."
      : ` (estimated up front: $${estimate.usd.toFixed(4)}${estimate.articleUsd === null ? "" : `, plus at most $${estimate.articleUsd.toFixed(4)} for the About article`}).`;
  const lines = [
    `# Update: ${markdownCodeSpan(repoName)} ${update.from.slice(0, 7)} → ${update.to.slice(0, 7)}`,
    "",
    `${pr}; ${update.commits} new commits, ${update.changes} files changed; ${drift}; ${update.tieBreak.placed.size} new files settled by the tie-break.`,
    "",
    `${update.stored.length} pages stored, ${update.carried.length} carried forward, ${update.staleClaims} claims marked out of date.`,
    "",
    ...(update.failures.length === 0
      ? []
      : [
          `${update.failures.length} whole ${update.failures.length === 1 ? "page" : "pages"} could not be written and ${update.failures.length === 1 ? "is" : "are"} not stored.`,
          "",
        ]),
    "| Feature | Reason | Claims | Kept stale | Result |",
    "|---|---|---:|---:|---|",
    ...update.stored.map((r) => {
      const outcome = update.rewrites.find((o) => o.featureId === r.featureId);
      const stale = outcome?.keptStale.length ?? 0;
      return `| ${cell(r.featureId)} | ${r.reason} | ${claimsOf(r)} | ${stale} | stored |`;
    }),
    ...update.rewrites
      .filter((o) => !update.stored.some((r) => r.featureId === o.featureId))
      .map((o) => `| ${cell(o.featureId)} | update | 0 | 0 | ${cell(o.failure ?? "unchanged")} |`),
    ...update.failures.map((f) => `| ${cell(f.featureId)} | whole | 0 | 0 | ${cell(f.failure)} |`),
    architectureRow({
      outcome: update.architecture,
      skipped: update.architecture === null ? "current" : null,
    }),
    "",
    ...costLines(totals, upFront, estimate !== null),
  ];
  return `${lines.join("\n")}\n`;
}
