import type { Project } from "@repowiki/hosted";
import type { Queryable } from "../db/db.ts";
import type { Session } from "../http/session.ts";
import { projectById } from "../store/projects.ts";

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
