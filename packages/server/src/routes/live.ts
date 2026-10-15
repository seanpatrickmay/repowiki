import type { EligibilityFacts, Project } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Queryable } from "../db/db.ts";
import { type GitHubRepo, githubApi } from "../github/api.ts";
import { eligibilityFacts } from "../github/facts.ts";
import type { Reply } from "../http/router.ts";
import { redirect } from "../http/server.ts";
import type { Session } from "../http/session.ts";
import { readGitHubToken } from "../store/github-tokens.ts";
import { projectById } from "../store/projects.ts";

export type Live =
  | { ok: true; facts: EligibilityFacts; repo: GitHubRepo | null; token: string }
  | { ok: false; reply: Reply };

/** A live eligibility check as the signed-in user (spec 2 S8), or the reply to send instead. */
export async function liveEligibility(
  deps: Deps,
  session: Session,
  githubRepoId: number,
): Promise<Live> {
  const token = await readGitHubToken(deps.db, deps.config.tokenKey, session.account.id);
  if (token === null) return { ok: false, reply: redirect("/auth/github") };
  const { facts, repo } = await eligibilityFacts(githubApi(deps.fetch, deps.github), token, {
    githubUserId: session.account.githubUserId,
    login: session.account.login,
    githubRepoId,
    now: deps.now(),
    indexedFiles: null,
  });
  return { ok: true, facts, repo, token };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The session's own project, or null: another account's id is indistinguishable from none (C10). */
export async function ownedProject(
  q: Queryable,
  session: Session,
  id: string,
  forUpdate = false,
): Promise<Project | null> {
  if (!UUID.test(id)) return null;
  const project = await projectById(q, id, forUpdate);
  return project !== null && project.accountId === session.account.id ? project : null;
}

/** The repository's full name as last checked, or null. */
export async function repoFullName(q: Queryable, githubRepoId: number): Promise<string | null> {
  const rows = await q.query<{ full_name: string }>(
    "SELECT body->>'fullName' AS full_name FROM repositories WHERE github_repo_id = $1",
    [githubRepoId],
  );
  return rows[0]?.full_name ?? null;
}
