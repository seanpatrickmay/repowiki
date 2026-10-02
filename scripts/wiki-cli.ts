import { parseArgs } from "node:util";
import {
  type ContextPack,
  estimateTokens,
  markdownCodeSpan,
  markdownOneLine,
  type PageOutcome,
} from "@repowiki/engine";
import { callCostUsd, type LedgerTotals } from "@repowiki/llm";
import { CliError } from "./manifest-cli.ts";

const USAGE =
  "usage: pnpm wiki:build <repo-path> [rev] [--out dir] [--config file.json] [--no-batch] [--dry-run] [--budget tokens] [--deadline minutes]";

/** A Message Batch can run for 24 hours; a longer deadline never fires. */
const MAX_DEADLINE_MINUTES = 24 * 60;

export interface WikiArgs {
  repo: string;
  rev: string;
  out: string | null;
  config: string | null;
  batch: boolean;
  dryRun: boolean;
  budgetTokens: number;
  /** Cancel each Message Batch still running after this many minutes; null waits (at most 24 h). */
  deadlineMinutes: number | null;
}

/** A usage error names the offending flag and never the value given with it. */
const flagError = (flag: string, problem: string): CliError =>
  new CliError(`${flag} ${problem}; ${USAGE}`);

const budgetTokens = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const n = Number(value);
  if (value.trim() === "" || !Number.isSafeInteger(n) || n <= 0)
    throw flagError("--budget", "must be a positive integer");
  return n;
};

const deadlineMinutes = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const n = Number(value);
  if (value.trim() === "" || !(n > 0 && n <= MAX_DEADLINE_MINUTES))
    throw flagError(
      "--deadline",
      `must be a number of minutes above 0 and up to ${MAX_DEADLINE_MINUTES}`,
    );
  return n;
};

/** `<repo> [rev]` plus flags in any order; throws a CliError for any other usage. */
export function parseWikiArgs(argv: readonly string[]): WikiArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    // node's message quotes the whole argument, `--flag=secret` included; keep the flag only
    const flag = /'(--?[A-Za-z0-9-]+)/.exec((err as Error).message)?.[1];
    throw new CliError(`${flag === undefined ? "bad option" : `bad option ${flag}`}; ${USAGE}`, {
      cause: err,
    });
  }
  const [repo, rev = "HEAD", ...extra] = parsed.positionals;
  if (repo === undefined || extra.length > 0) throw new CliError(USAGE);
  const v = parsed.values;
  return {
    repo,
    rev,
    out: v.out ?? null,
    config: v.config ?? null,
    batch: !v["no-batch"],
    dryRun: v["dry-run"] ?? false,
    budgetTokens: budgetTokens(v.budget) ?? 30_000,
    deadlineMinutes: deadlineMinutes(v.deadline),
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: "string" },
      config: { type: "string" },
      "no-batch": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      budget: { type: "string" },
      deadline: { type: "string" },
    },
  });
}

/** Output tokens a page is assumed to take before any is written (the prototype's averaged 3-4K). */
export const ASSUMED_PAGE_OUTPUT_TOKENS = 4000;

export interface BuildEstimate {
  pages: number;
  inputTokens: number;
  outputTokens: number;
  /** First round only, no cache hits; a retry round adds at most about the same per retried page. */
  usd: number;
}

/**
 * The cost of a build's first round, stated before any call (owner directive): every page sends
 * the shared prefix and its pack and is assumed to answer ASSUMED_PAGE_OUTPUT_TOKENS, priced at
 * the model's rates, halved when batched. Cache reads would only lower it.
 */
export function estimateBuild(
  packs: readonly ContextPack[],
  system: string,
  model: string,
  batch: boolean,
): BuildEstimate {
  const prefixTokens = estimateTokens(system);
  const inputTokens = packs.reduce((n, p) => n + p.tokens + prefixTokens, 0);
  const outputTokens = packs.length * ASSUMED_PAGE_OUTPUT_TOKENS;
  const usd =
    callCostUsd(
      model,
      { in: inputTokens, out: outputTokens, cacheRead: 0, cacheWrite: 0 },
      batch,
    ) ?? Number.NaN;
  return { pages: packs.length, inputTokens, outputTokens, usd };
}

const count = (n: number): string => n.toLocaleString("en-US");

/** A feature id in a table cell: a code span whose pipes cannot split the row. */
const idCell = (id: string): string => markdownCodeSpan(id).replace(/\|/g, "\\|");

/** A failure message in a table cell: one line, and nothing that can start a link, span or tag. */
const failureCell = (failure: string): string =>
  markdownOneLine(failure).replace(/[|`<>[\]\\]/g, " ");

/** The build summary saved for the owner: pages, drops, and the ledger's cost with cache use. */
export function renderBuildSummary(
  repoName: string,
  sha: string,
  pages: readonly PageOutcome[],
  estimate: BuildEstimate | null,
  totals: LedgerTotals,
): string {
  const t = totals.tokens;
  const lines = [
    `# Build: ${markdownOneLine(repoName)} at ${sha.slice(0, 7)}`,
    "",
    `${pages.filter((p) => p.revision !== null).length} of ${pages.length} pages written, ${pages.reduce((n, p) => n + p.dropped.length, 0)} claims dropped.`,
    "",
    "| Feature | Claims | Dropped | Calls | Result |",
    "|---|---:|---:|---:|---|",
    ...pages.map((p) => {
      const claims = p.revision?.sections.reduce((n, s) => n + s.claims.length, 0) ?? 0;
      const result = p.failure === null ? "written" : failureCell(p.failure);
      return `| ${idCell(p.featureId)} | ${claims} | ${p.dropped.length} | ${p.calls} | ${result} |`;
    }),
    "",
    "## LLM cost",
    "",
    `${totals.calls} calls (${totals.batchCalls} batched): ${count(t.in)} input, ${count(t.out)} output, ${count(t.cacheRead)} cache-read, ${count(t.cacheWrite)} cache-write tokens.`,
    "",
    `Cost: $${totals.usd.toFixed(4)}${estimate === null ? "." : ` (estimated up front: $${estimate.usd.toFixed(4)} for the first round). The estimate is an upper-side estimate with no cache hits.`}`,
  ];
  return `${lines.join("\n")}\n`;
}
