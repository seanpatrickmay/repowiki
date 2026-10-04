import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type ArchitectureOutcome,
  type ContextPack,
  estimateTokens,
  markdownCodeSpan,
  type PageOutcome,
  WikiBuildError,
} from "@repowiki/engine";
import { callCostUsd, type LedgerTotals } from "@repowiki/llm";
import { CliError } from "./manifest-cli.ts";

const USAGE =
  "usage: pnpm wiki:build <repo-path> [rev] [--out dir] [--config file.json] [--no-batch] [--dry-run] [--budget tokens] [--deadline minutes] [--verbose]";

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
  /** Print an error's causes under its one line. */
  verbose: boolean;
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
    verbose: once("--verbose", v.verbose) ?? false,
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
      verbose: { type: "boolean", multiple: true },
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

/** True unless the lock names a pid no process has: a build killed hard leaves such a lock. */
function holderAlive(path: string): boolean {
  const pid = Number(/^pid (\d+) /.exec(readFileSync(path, "utf8"))?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Opens the lock file only if no other process has it; null when one does. */
function openNew(path: string): number | null {
  try {
    return openSync(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
}

/**
 * Why a lock someone holds can be taken over, or null while its holder runs. A lock that vanished
 * while being looked at was freed: it can be taken too.
 */
function takeOverReason(path: string): string | null {
  try {
    if (Date.now() - statSync(path).mtimeMs >= STALE_LOCK_MS) {
      return `ignoring a stale lock older than 24 hours: ${path}`;
    }
    return holderAlive(path)
      ? null
      : `ignoring the lock of a build that is no longer running: ${path}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return `the lock was freed: ${path}`;
    throw err;
  }
}

/**
 * Takes the out dir's build lock, so two runs (wiki:build, wiki:update or wiki:replay) never send
 * the same batches twice, and returns the function that frees it. The lock holds this process's
 * pid and is freed on exit, SIGINT and SIGTERM too. A lock another live run holds is a
 * WikiBuildError; one older than 24 hours, or whose pid no process has, is taken over with a line
 * to `log`. Two runs taking over the same lock at once race to create it again, and the loser
 * gets the same WikiBuildError, never a raw fs error. Advisory: it guards these scripts against
 * each other only.
 */
export function acquireBuildLock(out: string, log: (line: string) => void): () => void {
  const path = join(out, BUILD_LOCK);
  const busy = () =>
    new WikiBuildError(
      `another wiki:build, wiki:update or wiki:replay is running on ${out} (${path}); if none is, delete the lock file`,
    );
  let fd = openNew(path);
  if (fd === null) {
    const reason = takeOverReason(path);
    if (reason === null) throw busy();
    rmSync(path, { force: true });
    log(reason);
    fd = openNew(path);
    if (fd === null) throw busy();
  }
  try {
    writeSync(fd, `pid ${process.pid} since ${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  const release = () => {
    process.off("exit", release);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    rmSync(path, { force: true });
  };
  // Free the lock, then let the signal end the process as it would have.
  const onSignal = (signal: NodeJS.Signals) => {
    release();
    process.kill(process.pid, signal);
  };
  process.once("exit", release);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return release;
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
  /** The Architecture call's estimate (estimateArchitecture), when the build will make one. */
  architectureUsd?: number;
}

/** Output tokens the Architecture article is assumed to take: a long page's. */
export const ASSUMED_ARCHITECTURE_OUTPUT_TOKENS = 5000;

/** The cost of some tokens at a model's rates; a CliError for a model with no price. */
function priced(model: string, inputTokens: number, outputTokens: number, batch: boolean): number {
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
  return usd;
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
  const usd = priced(model, inputTokens, outputTokens, batch);
  return { pages: packs.length, inputTokens, outputTokens, usd };
}

/**
 * The Architecture call's cost, stated before any call. Its pack needs the pages' leads, so it
 * cannot be built yet: the estimate takes the whole pack budget, the system prompt and
 * ASSUMED_ARCHITECTURE_OUTPUT_TOKENS, priced like a page (an upper-side figure).
 */
export function estimateArchitecture(
  system: string,
  budgetTokens: number,
  model: string,
  batch: boolean,
): { inputTokens: number; outputTokens: number; usd: number } {
  const inputTokens = estimateTokens(system) + budgetTokens;
  const outputTokens = ASSUMED_ARCHITECTURE_OUTPUT_TOKENS;
  return { inputTokens, outputTokens, usd: priced(model, inputTokens, outputTokens, batch) };
}

/** What the build did about the Architecture article, for its summary row. */
export interface ArchitectureRow {
  outcome: ArchitectureOutcome | null;
  skipped: "current" | "too few pages" | null;
}

const count = (n: number): string => n.toLocaleString("en-US");

/** A feature id or failure message in a table cell: a code span whose pipes cannot split the row. */
const cell = (text: string): string => markdownCodeSpan(text).replace(/\|/g, "\\|");

/** The summary's row for the project's article (the About page). */
function architectureRow({ outcome, skipped }: ArchitectureRow): string {
  if (outcome === null) {
    const why =
      skipped === "current" ? "already current; no call" : "skipped: fewer than two pages";
    return `| About article | 0 | 0 | 0 | ${why} |`;
  }
  const claims = outcome.architecture?.sections.reduce((n, s) => n + s.claims.length, 0) ?? 0;
  const result = outcome.failure === null ? "written" : cell(outcome.failure);
  return `| About article | ${claims} | ${outcome.dropped.length} | ${outcome.calls} | ${result} |`;
}

/**
 * The build summary saved for the owner: pages, drops, the Architecture article's row when
 * `architecture` is given, and the ledger's cost with cache use.
 */
export function renderBuildSummary(
  repoName: string,
  sha: string,
  pages: readonly PageOutcome[],
  estimate: BuildEstimate | null,
  totals: LedgerTotals,
  architecture?: ArchitectureRow,
): string {
  const t = totals.tokens;
  const upFront =
    estimate === null
      ? "."
      : ` (estimated up front: $${estimate.usd.toFixed(4)} for the first round${estimate.architectureUsd === undefined ? "" : `, plus $${estimate.architectureUsd.toFixed(4)} for the About article`}).`;
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
    ...(architecture === undefined ? [] : [architectureRow(architecture)]),
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
    `Cost: $${totals.usd.toFixed(4)}${upFront}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** The longest cause line --verbose prints: a cause can quote stored model output. */
const MAX_CAUSE_LENGTH = 300;
/** How many causes deep --verbose follows the chain. */
const MAX_CAUSES = 5;

/**
 * An error as the scripts print it: its one-line message, and with `verbose` each cause in its
 * chain on a line of its own ("caused by: Name: message"), printable ASCII only and cut short,
 * since a cause such as a failed manifest verify on open quotes stored model output.
 */
export function describeError(err: unknown, verbose: boolean): string {
  const lines = [err instanceof Error ? err.message : String(err)];
  let cause = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; verbose && cause !== undefined && depth < MAX_CAUSES; depth++) {
    const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    const line = text.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "?");
    lines.push(`caused by: ${line.slice(0, MAX_CAUSE_LENGTH)}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}
