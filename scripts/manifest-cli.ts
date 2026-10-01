import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { LedgerEntry } from "@repowiki/core";
import { GitError, ManifestBuildError, manifestCacheKey } from "@repowiki/engine";
import { LlmError, resolveModels } from "@repowiki/llm";

const USAGE =
  "usage: pnpm manifest:build <repo-path> [rev] [--out dir] [--config file.json] [--no-batch]";

/** A mistake in how the command was invoked: one line on stderr, exit 2. */
export class CliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface ManifestArgs {
  repo: string;
  rev: string;
  out: string | null;
  config: string | null;
  batch: boolean;
}

/** `<repo> [rev]` plus flags in any order; throws a CliError for any other usage. */
export function parseManifestArgs(argv: readonly string[]): ManifestArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    throw new CliError(`${oneLine((err as Error).message)}; ${USAGE}`, { cause: err });
  }
  const [repo, rev = "HEAD", ...extra] = parsed.positionals;
  if (repo === undefined || extra.length > 0) throw new CliError(USAGE);
  const { out, config, "no-batch": noBatch } = parsed.values;
  return { repo, rev, out: out ?? null, config: config ?? null, batch: !noBatch };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: "string" },
      config: { type: "string" },
      "no-batch": { type: "boolean", default: false },
    },
  });
}

const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** Per-role model ids: the defaults, overridden by an `LlmConfigFile` JSON file when given. */
export function loadModels(configPath: string | null): ReturnType<typeof resolveModels> {
  if (configPath === null) return resolveModels();
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new CliError(`cannot read config ${configPath}: ${oneLine((err as Error).message)}`, {
      cause: err,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new CliError(
      `config ${configPath} is not valid JSON: ${oneLine((err as Error).message)}`,
      {
        cause: err,
      },
    );
  }
  try {
    return resolveModels(json);
  } catch (err) {
    const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    if (issues === undefined) throw err;
    const detail = issues
      .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${oneLine(i.message)}`)
      .join("; ");
    throw new CliError(`invalid config ${configPath}: ${detail}`, { cause: err });
  }
}

/** The exit code for an expected failure (2 usage, 1 build, git or LLM), or null for a bug. */
export function exitCodeFor(err: unknown): 1 | 2 | null {
  if (err instanceof CliError) return 2;
  if (err instanceof ManifestBuildError || err instanceof GitError || err instanceof LlmError) {
    return 1;
  }
  return null;
}

const RUN_PREFIX = "manifest-build-";

/** The run id of a manifest:build run; it names the sha because batched calls carry no cacheKey. */
export function manifestRunId(sha: string, at: Date): string {
  return `${RUN_PREFIX}${sha}-${at.toISOString()}`;
}

/**
 * The ledger rows that paid for the manifest of `sha`: manifest calls from a run for that sha, or
 * whose cacheKey belongs to it (rows written before run ids named the sha, and before the
 * cacheKey carried a prompt hash). Other purposes, such as M4's write calls appended to the
 * same store, are left out of the manifest's cost.
 */
export function manifestLedgerRows(entries: readonly LedgerEntry[], sha: string): LedgerEntry[] {
  const key = manifestCacheKey(sha);
  return entries.filter(
    (e) =>
      e.purpose === "manifest" &&
      (e.runId.startsWith(`${RUN_PREFIX}${sha}-`) ||
        (e.cacheKey !== null && (e.cacheKey === key || e.cacheKey.startsWith(`${key}-`)))),
  );
}
