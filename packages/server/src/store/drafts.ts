import { DraftRevision, Generation } from "@repowiki/hosted";
import type { Queryable } from "../db/db.ts";
import { asJson, parsedBody } from "./rows.ts";

export async function generationById(q: Queryable, id: string): Promise<Generation | null> {
  const rows = await q.query<{ body: unknown }>("SELECT body FROM generations WHERE id = $1", [id]);
  return rows[0] === undefined ? null : parsedBody(Generation, rows[0].body, "generation");
}

/** Generations are immutable: inserting an existing id is an error. */
export async function saveGeneration(q: Queryable, generation: Generation): Promise<void> {
  const body = parsedBody(Generation, generation, "generation");
  await q.query("INSERT INTO generations (id, project_id, body) VALUES ($1, $2, $3::jsonb)", [
    body.id,
    body.projectId,
    asJson(body),
  ]);
}

export async function latestRevision(
  q: Queryable,
  projectId: string,
): Promise<DraftRevision | null> {
  const rows = await q.query<{ body: unknown }>(
    "SELECT body FROM revisions WHERE project_id = $1 ORDER BY number DESC LIMIT 1",
    [projectId],
  );
  return rows[0] === undefined ? null : parsedBody(DraftRevision, rows[0].body, "revision");
}

/** Revisions are immutable (Contract C4): inserting an existing number is an error. */
export async function saveRevision(q: Queryable, revision: DraftRevision): Promise<void> {
  const body = parsedBody(DraftRevision, revision, "revision");
  await q.query("INSERT INTO revisions (project_id, number, body) VALUES ($1, $2, $3::jsonb)", [
    body.projectId,
    body.number,
    asJson(body),
  ]);
}
