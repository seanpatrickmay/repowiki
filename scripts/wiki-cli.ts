import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type ArchitectureOutcome,
  type BuildJournal,
  type ContextPack,
  estimateTokens,
  markdownCodeSpan,
  type PageOutcome,
  StoreError,
  UpdateError,
  WikiBuildError,
} from "@repowiki/engine";
import {
  callCostUsd,
  createClaudeProvider,
  type LedgerTotals,
  LlmError,
  type ModelConfig,
  type Provider,
  type TokenLedger,
} from "@repowiki/llm";
import { CliError, exitCodeFor } from "./manifest-cli.ts";

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
const flagError = (flag: string, problem: string, usage: string): CliError =>
  new CliError(`${flag} ${problem}; ${usage}`);

/** The one value of a flag given at most once; an empty or repeated one is a usage error. */
function once<T extends string | boolean>(
  flag: string,
  values: T[] | undefined,
  usage: string,
): T | undefined {
  if (values !== undefined && values.length > 1)
    throw flagError(flag, "was given more than once", usage);
  const [value] = values ?? [];
  if (value === "") throw flagError(flag, "must not be empty", usage);
  return value;
}

/** A flag's positive integer value, or null when the flag is absent. */
const positive = (flag: string, value: string | undefined, usage: string): number | null => {
  if (value === undefined) return null;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n <= 0)
    throw flagError(flag, "must be a positive integer", usage);
  return n;
};

const deadlineMinutes = (value: string | undefined, usage: string): number | null => {
  if (value === undefined) return null;
  const n = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || !(n > 0 && n <= MAX_DEADLINE_MINUTES))
    throw flagError(
      "--deadline",
      `must be a number of minutes above 0 and up to ${MAX_DEADLINE_MINUTES}`,
      usage,
    );
  return n;
};

/** The longest unknown flag a usage error echoes. */
const MAX_ECHOED_FLAG = 40;

/** The flags wiki:build, wiki:update and wiki:replay share. */
export type RunFlags = Omit<WikiArgs, "repo" | "rev">;

/**
 * Parses `argv` into positionals and the shared flags, plus `--limit N` when `limit` is set;
 * every usage error is a CliError ending in `usage`.
 */
export function parseRunArgs(
  argv: readonly string[],
  usage: string,
  limit = false,
): { positionals: string[]; flags: RunFlags; limit: number | null } {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv, limit);
  } catch (err) {
    // node's message quotes the whole argument, `--flag=secret` included: keep the flag, cut short
    const flag = /'(-[^'=\s]*)/.exec((err as Error).message)?.[1];
    const shown = flag?.slice(0, MAX_ECHOED_FLAG).replace(/[^\x21-\x7e]/g, "?");
    throw new CliError(`${shown === undefined ? "bad option" : `bad option ${shown}`}; ${usage}`, {
      cause: err,
    });
  }
  const v = parsed.values;
  return {
    positionals: parsed.positionals,
    flags: {
      out: once("--out", v.out, usage) ?? null,
      config: once("--config", v.config, usage) ?? null,
      batch: !once("--no-batch", v["no-batch"], usage),
      dryRun: once("--dry-run", v["dry-run"], usage) ?? false,
      budgetTokens: positive("--budget", once("--budget", v.budget, usage), usage) ?? 30_000,
      deadlineMinutes: deadlineMinutes(once("--deadline", v.deadline, usage), usage),
      verbose: once("--verbose", v.verbose, usage) ?? false,
    },
    limit: positive("--limit", once("--limit", v.limit as string[] | undefined, usage), usage),
  };
}

/** `<repo> [rev]` plus flags in any order; throws a CliError for any other usage. */
export function parseWikiArgs(argv: readonly string[]): WikiArgs {
  const { positionals, flags } = parseRunArgs(argv, USAGE);
  const [repo, rev = "HEAD", ...extra] = positionals;
  if (repo === undefined || extra.length > 0) throw new CliError(USAGE);
  if (repo === "") throw new CliError(`<repo-path> must not be empty; ${USAGE}`);
  return { repo, rev, ...flags };
}

function parse(argv: readonly string[], limit: boolean) {
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
      ...(limit ? { limit: { type: "string", multiple: true } as const } : {}),
    },
  });
}

/** The commands that make live calls and so need the key. */
export type LiveCommand = "wiki:build" | "wiki:update" | "wiki:replay";

/** Why a run that needs a call cannot make one; the commands load .env only if present. */
export function keylessMessage(command: LiveCommand): string {
  return `ANTHROPIC_API_KEY is not set: pnpm ${command} reads it from a .env file in the directory it runs in, if there is one (node --env-file-if-exists=.env); add it there, or run node --env-file=<path to .env> scripts/${command.replace(":", "-")}.ts`;
}

/** Throws the one-line keyless LlmError when ANTHROPIC_API_KEY is unset or empty. */
export function requireApiKey(command: LiveCommand): void {
  if (!process.env.ANTHROPIC_API_KEY) throw new LlmError(keylessMessage(command));
}

export interface LazyClaudeOptions {
  command: LiveCommand;
  models: ModelConfig;
  ledger: TokenLedger;
  runId: string;
  run: { kind: "build" | "update"; sha: string };
  journal: BuildJournal;
  deadlineMinutes: number | null;
  log: (line: string) => void;
}

/**
 * A Provider that builds the Claude provider on its first call, so a run that needs no call needs
 * no API key; with no key that first call throws the command's keyless LlmError. Batch progress
 * goes to `log`; the batch journal is the store's, so a killed run's batches are collected again.
 */
export function lazyClaudeProvider(options: LazyClaudeOptions): Provider {
  let claude: Provider | undefined;
  return {
    generate: (request) => {
      if (claude === undefined) requireApiKey(options.command);
      claude ??= createClaudeProvider({
        models: options.models,
        ledger: options.ledger,
        runId: options.runId,
        run: options.run,
        batchJournal: options.journal,
        onBatchRequest: options.journal.tag,
        ...(options.deadlineMinutes === null
          ? {}
          : { batchDeadlineMs: options.deadlineMinutes * 60_000 }),
        onBatchCreated: (b) => options.log(`batch ${b.id} created (${b.requests} requests)`),
        onBatchProgress: (p) =>
          options.log(
            `batch ${p.id}: ${p.status} (${p.processing} processing, ${p.succeeded} done)`,
          ),
      });
      return claude.generate(request);
    },
  };
}

/**
 * Writes `text` to `path` as a whole or not at all: a temporary file beside it (created
 * exclusively, so a planted link is never followed), then a rename, which replaces a symlink at
 * `path` itself rather than writing through it.
 */
export function writeFileAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The ledger run id of a wiki:build starts with this (a manifest:build's does not). */
export const WIKI_BUILD_RUN_PREFIX = "wiki-build-";

/** The advisory lock file a running wiki:build holds in its out dir. */
export const BUILD_LOCK = "wiki-build.lock";
/** A lock whose line names no pid, older than this, is left over from a killed build (a batch ends in 24 h). */
const STALE_LOCK_MS = 24 * 60 * 60 * 1000;

/** The pid a lock line names, or null when it names none. */
function lockPid(text: string): number | null {
  const pid = Number(/^pid (\d+) /.exec(text)?.[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** True unless `pid` is a process this host does not have (a build killed hard leaves such a lock). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return codeOf(err) !== "ESRCH";
  }
}

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException).code;

/** Publishes `tmp` as `path` only if nothing is there: link fails with EEXIST, never replaces. */
function linkNew(tmp: string, path: string): boolean {
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if (codeOf(err) === "EEXIST") return false;
    throw err;
  }
}

/** A lock judged takeable: why, and which file (inode and content) was judged. */
interface JudgedLock {
  reason: string;
  ino: number;
  text: string;
}

/**
 * Judges a lock someone holds: null while its holder runs, "freed" when it vanished while being
 * looked at, otherwise why it can be taken over and exactly which file that judgment is about.
 * A lock naming a pid is stale exactly when that pid is gone from this host: its age says
 * nothing, since the lock is never refreshed and a replay of batched steps can run past 24
 * hours. Only a lock that names no pid, so cannot be checked, falls back to its age.
 */
function judgeLock(path: string): JudgedLock | "freed" | null {
  try {
    const { mtimeMs, ino } = statSync(path);
    const text = readFileSync(path, "utf8");
    const pid = lockPid(text);
    if (pid !== null) {
      return pidAlive(pid)
        ? null
        : { reason: `ignoring the lock of a build that is no longer running: ${path}`, ino, text };
    }
    return Date.now() - mtimeMs >= STALE_LOCK_MS
      ? { reason: `ignoring a stale lock older than 24 hours: ${path}`, ino, text }
      : null;
  } catch (err) {
    if (codeOf(err) === "ENOENT") return "freed";
    throw err;
  }
}

/**
 * Moves a lock judged stale out of the way, and only that lock. Renaming is the one step that
 * takes whatever is at the path, so the moved file is checked to be the one judged: if another
 * run took the lock after the judgment, a live lock was moved, and it is put back (link, which
 * never replaces) before refusing. Returns false when the lock vanished first.
 */
function moveStaleAside(path: string, judged: JudgedLock, busy: () => Error): boolean {
  const aside = `${path}.${process.pid}.${randomUUID()}.stale`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return false;
    throw err;
  }
  try {
    const moved = statSync(aside);
    if (moved.ino === judged.ino && readFileSync(aside, "utf8") === judged.text) return true;
    try {
      linkSync(aside, path);
    } catch (err) {
      // Another run has since taken the path; the moved lock cannot be put back.
      if (codeOf(err) !== "EEXIST") throw err;
    }
    throw busy();
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Takes the out dir's build lock, so two runs (wiki:build, wiki:update or wiki:replay) never send
 * the same batches twice, and returns the function that frees it. The lock holds this run's
 * "pid … since …" line, published atomically: the line is written to a temp file and linked to
 * the lock path, which fails if any lock exists, so a lock is never seen half-written and never
 * replaced. A lock another live run holds is a WikiBuildError. A lock whose pid no process on this
 * host has, or (when its line names no pid) one older than 24 hours, is taken over with a line to
 * `log`: it is renamed aside, checked to be the file that was judged stale (a lock taken in the
 * meantime is put back and respected), and then the lock is created as above, so of any runs
 * racing for it exactly one holds it and the rest get the same WikiBuildError. No POSIX call compares and swaps a path, so a third run
 * landing between the check and the put-back can still go unnoticed; the window is microseconds.
 * The lock is freed on exit, SIGINT and SIGTERM too, and only while it still holds this run's own
 * line. Advisory: it guards these scripts against each other only. `afterJudging` is a test seam
 * that runs between judging a lock stale and taking it over.
 */
export function acquireBuildLock(
  out: string,
  log: (line: string) => void,
  afterJudging?: () => void,
): () => void {
  const path = join(out, BUILD_LOCK);
  const busy = () =>
    new WikiBuildError(
      `another wiki:build, wiki:update or wiki:replay is running on ${out} (${path}); if none is, delete the lock file`,
    );
  const line = `pid ${process.pid} since ${new Date().toISOString()} id ${randomUUID()}\n`;
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, line, { flag: "wx" });
  try {
    if (!linkNew(tmp, path)) {
      const judged = judgeLock(path);
      if (judged === null) throw busy();
      afterJudging?.();
      if (judged === "freed") {
        log(`the lock was freed: ${path}`);
      } else if (moveStaleAside(path, judged, busy)) {
        log(judged.reason);
      }
      if (!linkNew(tmp, path)) throw busy();
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  const release = () => {
    process.off("exit", release);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      // Another run may hold the lock by now (this one was displaced): leave it be.
      if (readFileSync(path, "utf8") === line) rmSync(path, { force: true });
    } catch (err) {
      if (codeOf(err) !== "ENOENT") throw err;
    }
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
export function priced(
  model: string,
  inputTokens: number,
  outputTokens: number,
  batch: boolean,
): number {
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

export const count = (n: number): string => n.toLocaleString("en-US");

/** A feature id or failure message in a table cell: a code span whose pipes cannot split the row. */
export const cell = (text: string): string => markdownCodeSpan(text).replace(/\|/g, "\\|");

/** Why the About article made no call, as an update summary and a replay summary both say it. */
export const architectureSkipWhy = (skipped: ArchitectureRow["skipped"]): string =>
  skipped === "current" ? "already current; no call" : "skipped: fewer than two pages";

/** The summary's row for the project's article (the About page). */
export function architectureRow({ outcome, skipped }: ArchitectureRow): string {
  if (outcome === null) return `| About article | 0 | 0 | 0 | ${architectureSkipWhy(skipped)} |`;
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
    ...costLines(totals, upFront, estimate !== null),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * A summary's "LLM cost" section: the ledger's calls and tokens, unpriced calls, and the cost
 * with `upFront` (the estimate's sentence ending, or ".") after it.
 */
export function costLines(totals: LedgerTotals, upFront: string, estimated: boolean): string[] {
  const t = totals.tokens;
  return [
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
    ...(estimated ? ["The estimate is an upper-side estimate with no cache hits.", ""] : []),
    `Cost: $${totals.usd.toFixed(4)}${upFront}`,
  ];
}

/** The longest cause line --verbose prints: a cause can quote stored model output. */
const MAX_CAUSE_LENGTH = 300;
/** How many causes deep --verbose follows the chain. */
const MAX_CAUSES = 5;

/** The shape of an Anthropic key, redacted even when it is not the configured one. */
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]*/g;

/** Every occurrence of the configured API key, and of anything key-shaped, replaced. */
function redact(text: string): string {
  const key = process.env.ANTHROPIC_API_KEY;
  const plain = key ? text.split(key).join("[redacted]") : text;
  return plain.replace(KEY_SHAPE, "[redacted]");
}

/** A value's text, never throwing: a null-prototype object has no toString to call. */
function textOf(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * One printable line: any API key redacted first (a cut or a character filter must never leave
 * part of one), then whitespace collapsed and everything but printable ASCII replaced.
 */
function printable(text: string): string {
  return redact(text)
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?");
}

/** The longest problem line a script prints. */
const MAX_PROBLEM_LENGTH = 300;

/**
 * A checkWiki problem (or a git error line) as a script prints it. Problems quote ids and paths
 * that came from a model, so each is one printable line, redacted of API keys, cut short.
 */
export const problemLine = (line: string): string => printable(line).slice(0, MAX_PROBLEM_LENGTH);

/**
 * An error as the scripts print it: its one-line message, and with `verbose` each cause in its
 * chain on a line of its own ("caused by: Name: message"). Every line is redacted of API keys
 * (a rejected header value is echoed in its error, key included) and printable ASCII only; cause
 * lines are cut short, since a cause such as a failed manifest verify on open quotes stored model
 * output.
 */
export function describeError(err: unknown, verbose: boolean): string {
  const lines = [printable(err instanceof Error ? err.message : textOf(err))];
  let cause = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; verbose && cause !== undefined && depth < MAX_CAUSES; depth++) {
    const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : textOf(cause);
    lines.push(`caused by: ${printable(text).slice(0, MAX_CAUSE_LENGTH)}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}

/**
 * Ends a script that failed: one redacted line through `describeError` (causes too with
 * `--verbose`, read raw from argv so a usage error still prints), then exit 2 for a usage error
 * and 1 for everything else, an unexpected error included: a bug is one line and a code, never a
 * stack trace. The caller's `finally` blocks have already run, so its lock is free by now.
 */
export function exitWithError(err: unknown): never {
  const known = err instanceof UpdateError || err instanceof WikiBuildError;
  const code = known || err instanceof StoreError ? 1 : (exitCodeFor(err) ?? 1);
  console.error(describeError(err, process.argv.includes("--verbose")));
  process.exit(code);
}
