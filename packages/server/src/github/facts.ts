import type { EligibilityFacts, Permission } from "@repowiki/hosted";
import { type GitHubApi, type GitHubRepo, TokenRevoked } from "./api.ts";

/** The strongest permission GitHub reports for the signed-in user; none when it reports none. */
export function permissionOf(repo: GitHubRepo): Permission {
  const p = repo.permissions;
  if (p === undefined) return "none";
  if (p.admin) return "admin";
  if (p.maintain) return "maintain";
  if (p.push) return "push";
  if (p.triage) return "triage";
  if (p.pull) return "pull";
  return "none";
}

export interface FactsInput {
  githubUserId: number;
  login: string;
  githubRepoId: number;
  now: string;
  indexedFiles: number | null;
}

/**
 * What GitHub says right now about this user and repository (spec 2 S8, Contract §7.2). A revoked
 * token and a repository GitHub will not show are facts, not errors; other failures throw.
 */
export async function eligibilityFacts(
  api: GitHubApi,
  token: string,
  input: FactsInput,
): Promise<{ facts: EligibilityFacts; repo: GitHubRepo | null }> {
  const base = {
    checkedAt: input.now,
    githubUserId: input.githubUserId,
    githubRepoId: input.githubRepoId,
    indexedFiles: input.indexedFiles,
  };
  const unavailable = (tokenValid: boolean): EligibilityFacts => ({
    ...base,
    fullName: "unknown/unknown",
    visibility: "private",
    isFork: false,
    permission: "none",
    authoredCommits: 0,
    tokenValid,
  });
  try {
    const repo = await api.repository(token, input.githubRepoId);
    if (repo === null) return { facts: unavailable(true), repo: null };
    const authoredCommits = await api.countCommits(token, repo.full_name, input.login);
    return {
      facts: {
        ...base,
        fullName: repo.full_name,
        visibility: repo.private ? "private" : "public",
        isFork: repo.fork,
        permission: permissionOf(repo),
        authoredCommits,
        tokenValid: true,
      },
      repo,
    };
  } catch (error) {
    if (error instanceof TokenRevoked) return { facts: unavailable(false), repo: null };
    throw error;
  }
}
