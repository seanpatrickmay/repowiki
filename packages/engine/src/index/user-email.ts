import { GitError, git } from "./git.ts";

/**
 * The address the repository's git is configured to commit with (`git config --get user.email`,
 * every config level), or null when none is set. People takes it as the owner's identity when the
 * people file names no `owner` (planner ruling R3). Read with the scrubbed environment, so no
 * GIT_CONFIG_* variable can supply it; compared only, never stored or printed.
 */
export function configuredEmail(repo: string): string | null {
  try {
    const email = git(repo, ["config", "--get", "user.email"]).toString("utf8").trim();
    return email === "" ? null : email;
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}
