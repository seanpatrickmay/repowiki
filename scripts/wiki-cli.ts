import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type ContextPack,
  estimateTokens,
  markdownCodeSpan,
  type PageOutcome,
  WikiBuildError,
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

/** The one value of a flag given at most once; an empty or repeated one is a usage error. */
function once<T extends string | boolean>(flag: string, values: T[] | undefined): T | undefined {
  if (values !== undefined && values.length > 1) throw flagError(flag, "was given more than once");
  const [value] = values ?? [];
  if (value === "") throw flagError(flag, "must not be empty");
  return value;
}

const budgetTokens = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n <= 0)
    throw flagError("--budget", "must be a positive integer");
  return n;
};

const deadlineMinutes = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const n = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || !(n > 0 && n <= MAX_DEADLINE_MINUTES))
    throw flagError(
      "--deadline",
      `must be a number of minutes above 0 and up to ${MAX_DEADLINE_MINUTES}`,
    );
  return n;
};

/** The longest unknown flag a usage error echoes. */
const MAX_ECHOED_FLAG = 40;

/** `<repo> [rev]` plus flags in any order; throws a CliError for any other usage. */
export function parseWikiArgs(argv: readonly string[]): WikiArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    // node's message quotes the whole argument, `--flag=secret` included: keep the flag, cut short
    const flag = /'(-[^'=\s]*)/.exec((err as Error).message)?.[1];
    const shown = flag?.slice(0, MAX_ECHOED_FLAG).replace(/[^\x21-\x7e]/g, "?");
    throw new CliError(`${shown === undefined ? "bad option" : `bad option ${shown}`}; ${USAGE}`, {
      cause: err,
    });
  }
  const [repo, rev = "HEAD", ...extra] = parsed.positionals;
  if (repo === undefined || extra.length > 0) throw new CliError(USAGE);
  if (repo === "") throw new CliError(`<repo-path> must not be empty; ${USAGE}`);
  const v = parsed.values;
  return {
    repo,
    rev,
    out: once("--out", v.out) ?? null,
    config: once("--config", v.config) ?? null,
    batch: !once("--no-batch", v["no-batch"]),
    dryRun: once("--dry-run", v["dry-run"]) ?? false,
    budgetTokens: budgetTokens(once("--budget", v.budget)) ?? 30_000,
    deadlineMinutes: deadlineMinutes(once("--deadline", v.deadline)),
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: "string", multiple: true },
      config: { type: "string", multiple: true },
      "no-batch": { type: "boolean", multiple: true },
      "dry-run": { type: "boolean", multiple: true },
      budget: { type: "string", multiple: true },
      deadline: { type: "string", multiple: true },
    },
  });
}

/** Why a build that needs a call cannot make one; `pnpm wiki:build` loads .env only if present. */
export const KEYLESS_MESSAGE =
  "ANTHROPIC_API_KEY is not set: pnpm wiki:build reads it from a .env file in the directory it runs in, if there is one (node --env-file-if-exists=.env); add it there, or run node --env-file=<path to .env> scripts/wiki-build.ts";

/** The advisory lock file a running wiki:build holds in its out dir. */
export const BUILD_LOCK = "wiki-build.lock";
/** A lock older than this is left over from a killed build, never a running one (a batch ends in 24 h). */
const STALE_LOCK_MS = 24 * 60 * 60 * 1000;

/**
 * Takes the out dir's build lock, so two builds never send the same batches twice, and returns
 * the function that frees it. A lock another build holds is a WikiBuildError; one older than 24
 * hours is taken over, with a line to `log`. Advisory: it guards wiki:build against itself only.
 */
export function acquireBuildLock(out: string, log: (line: string) => void): () => void {
  const path = join(out, BUILD_LOCK);
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const age = Date.now() - statSync(path).mtimeMs;
    if (age < STALE_LOCK_MS) {
      throw new WikiBuildError(
        `another wiki:build is running on ${out} (${path}); if none is, delete the lock file`,
      );
    }
    log(`ignoring a stale lock older than 24 hours: ${path}`);
    rmSync(path, { force: true });
    fd = openSync(path, "wx");
  }
  try {
    writeSync(fd, `pid ${process.pid} since ${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  return () => rmSync(path, { force: true });
}

/** The longest model id a usage error echoes. */
const MAX_ECHOED_MODEL = 80;

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
 * the model's rates, halved when batched. Cache reads would only lower it. A model with no price
 * in packages/llm is a CliError: the estimate would otherwise print $NaN.
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
  const usd = callCostUsd(
    model,
    { in: inputTokens, out: outputTokens, cacheRead: 0, cacheWrite: 0 },
    batch,
  );
  if (usd === null) {
    // the id is config data: one printable line, cut short
    const id = model.slice(0, MAX_ECHOED_MODEL).replace(/[^\x20-\x7e]/g, "?");
    throw new CliError(`no price for model ${id}; add it to packages/llm/src/pricing.ts`);
  }
  return { pages: packs.length, inputTokens, outputTokens, usd };
}

const count = (n: number): string => n.toLocaleString("en-US");

/** A feature id or failure message in a table cell: a code span whose pipes cannot split the row. */
const cell = (text: string): string => markdownCodeSpan(text).replace(/\|/g, "\\|");

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
    `# Build: ${markdownCodeSpan(repoName)} at ${sha.slice(0, 7)}`,
    "",
    `${pages.filter((p) => p.revision !== null).length} of ${pages.length} pages written, ${pages.reduce((n, p) => n + p.dropped.length, 0)} claims dropped.`,
    "",
    "| Feature | Claims | Dropped | Calls | Result |",
    "|---|---:|---:|---:|---|",
    ...pages.map((p) => {
      const claims = p.revision?.sections.reduce((n, s) => n + s.claims.length, 0) ?? 0;
      const result = p.failure === null ? "written" : cell(p.failure);
      return `| ${cell(p.featureId)} | ${claims} | ${p.dropped.length} | ${p.calls} | ${result} |`;
    }),
    "",
    "## LLM cost",
    "",
    ...(totals.calls === 0 ? ["This run: no LLM call made.", ""] : []),
    `${totals.calls} calls (${totals.batchCalls} batched): ${count(t.in)} input, ${count(t.out)} output, ${count(t.cacheRead)} cache-read, ${count(t.cacheWrite)} cache-write tokens.`,
    "",
    ...(totals.unpricedCalls > 0
      ? [
          `${totals.unpricedCalls} ${totals.unpricedCalls === 1 ? "call has" : "calls have"} no known price: their tokens are counted above, their cost is not in the total below.`,
          "",
        ]
      : []),
    ...(estimate === null
      ? []
      : ["The estimate is an upper-side estimate with no cache hits.", ""]),
    `Cost: $${totals.usd.toFixed(4)}${estimate === null ? "." : ` (estimated up front: $${estimate.usd.toFixed(4)} for the first round).`}`,
  ];
  return `${lines.join("\n")}\n`;
}
