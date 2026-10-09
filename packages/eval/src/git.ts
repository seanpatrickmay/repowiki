import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { GitError, scrubbedGitEnv } from "@repowiki/engine";

/** How long one git call may run before it is stopped. */
export const GIT_TIMEOUT_MS = 10_000;

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
 * The top level of the work tree `repo` is in (or `repo` itself, for a bare repository), so a
 * directory inside a repository gives the whole repository: grep then names every path from the
 * root, as list_files and read_file do.
 */
export function topLevel(repo: string): string {
  const result = runGit(repo, ["rev-parse", "--show-toplevel"], GIT_TIMEOUT_MS);
  const top = result.status === 0 ? result.stdout.toString("utf8").trim() : "";
  return top === "" ? repo : top;
}
