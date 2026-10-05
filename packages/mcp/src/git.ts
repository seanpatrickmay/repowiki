import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { GitError, scrubbedGitEnv } from "@repowiki/engine";

/** How long one git call may run before it is stopped (spec v2 #5 R21). */
export const GIT_TIMEOUT_MS = 10_000;

/** The most output one capped git call reads: a cited file or a commit's file list fits. */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs read-only git in `repo` with the engine's scrubbed environment (no redirection, no config
 * or pathspec rules from the environment, no lazy fetch) plus GIT_OPTIONAL_LOCKS=0, so not even
 * an index refresh writes a lock. A git that cannot start is a GitError; a timeout or an output
 * overflow (ENOBUFS, also when git exits just before the kill) is left for the caller to read
 * from `signal` and `error`.
 */
export function runGit(
  repo: string,
  args: readonly string[],
  timeout?: number,
  maxBuffer = 1 << 30,
): SpawnSyncReturns<Buffer> {
  const result = spawnSync("git", ["-C", repo, ...args], {
    env: scrubbedGitEnv({ GIT_OPTIONAL_LOCKS: "0" }),
    maxBuffer,
    timeout,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error !== undefined && result.signal === null && error.code !== "ENOBUFS") {
    throw new GitError(`could not run git: ${error.message}`);
  }
  return result;
}

/**
 * The stdout of a git call that must succeed within GIT_TIMEOUT_MS and GIT_MAX_BUFFER; anything
 * else (a failure, a timeout, too much output) is a GitError naming the command.
 */
export function gitOutput(repo: string, args: readonly string[]): Buffer {
  const result = runGit(repo, args, GIT_TIMEOUT_MS, GIT_MAX_BUFFER);
  if (result.signal !== null) throw new GitError(`git ${args[0]} took too long in ${repo}`);
  if (result.error !== undefined) throw new GitError(`git ${args[0]} wrote too much in ${repo}`);
  if (result.status !== 0) {
    const why = result.stderr.toString("utf8").trim().split("\n")[0] ?? "";
    throw new GitError(`git ${args[0]} failed in ${repo}: ${why}`);
  }
  return result.stdout;
}

/**
 * The top level of the work tree `repo` is in (or `repo` itself, for a bare repository), so a
 * directory inside a repository gives the whole repository.
 */
export function topLevel(repo: string): string {
  const result = runGit(repo, ["rev-parse", "--show-toplevel"], GIT_TIMEOUT_MS);
  const top = result.status === 0 ? result.stdout.toString("utf8").trim() : "";
  return top === "" ? repo : top;
}

/**
 * The full sha of the commit `rev` names in `repo`, or null when it names none (or more than one:
 * an ambiguous short sha). `rev` is passed after --end-of-options, so it is never an option.
 */
export function commitOf(repo: string, rev: string): string | null {
  const result = runGit(
    repo,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
    GIT_TIMEOUT_MS,
  );
  const sha = result.status === 0 ? result.stdout.toString("utf8").trim() : "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
