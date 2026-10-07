import { spawnSync } from "node:child_process";
import { GitError, type GitOptions, gitEnv, repoArgs, timeoutError } from "./git.ts";

/** How long a People git read other than the log and blame may run (the fix-forward ruling). */
export const PEOPLE_READ_TIMEOUT_MS = 120_000;

/**
 * The address the repository's git is configured to commit with (`git config --get user.email`),
 * or null when none is set. It reads the repository's effective config, local, global and
 * system, as `git config --get user.email` does: intended, since user.email is usually set
 * globally. The scrubbed environment drops config injected through GIT_CONFIG_COUNT and
 * GIT_CONFIG_PARAMETERS, but GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM still name files, as they
 * do for git. People takes it as the owner's identity when the people file names no `owner`
 * (planner ruling R3); compared only, never stored or printed. Only git's "not set" (exit 1, no
 * message) is null: any other failure, a timeout (PEOPLE_READ_TIMEOUT_MS by default) included,
 * is a GitError, so it never passes for "no owner" silently.
 */
export function configuredEmail(repo: string, options: GitOptions = {}): string | null {
  const timeoutMs = options.timeoutMs ?? PEOPLE_READ_TIMEOUT_MS;
  const args = ["config", "--get", "user.email"];
  const out = spawnSync("git", [...repoArgs(repo, options), ...args], {
    env: gitEnv(options),
    timeout: timeoutMs,
  });
  if (out.error)
    throw (
      timeoutError(out.error, repo, args, timeoutMs) ??
      new GitError(`could not run git: ${out.error.message}`)
    );
  const stderr = out.stderr?.toString("utf8").trim() ?? "";
  if (out.status === 1 && stderr === "") return null;
  if (out.status !== 0)
    throw new GitError(`git config failed: ${stderr.split("\n")[0] ?? `exit ${out.status}`}`);
  const email = out.stdout?.toString("utf8").trim() ?? "";
  return email === "" ? null : email;
}
