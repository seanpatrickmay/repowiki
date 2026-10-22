import { DraftRevision, Generation, Preview, PublishedVersion, Review } from "@repowiki/hosted";
import type { z } from "zod";
import type { Queryable } from "../db/db.ts";
import { asJson, parsedBody } from "./rows.ts";

export async function generationById(q: Queryable, id: string): Promise<Generation | null> {
  const rows = await q.query<{ body: unknown }>("SELECT body FROM generations WHERE id = $1", [id]);
  return rows[0] === undefined ? null : parsedBody(Generation, rows[0].body, "generation");
}

/** A project's generations, newest first. */
export async function generationsOf(q: Queryable, projectId: string): Promise<Generation[]> {
  const rows = await q.query<{ body: unknown }>(
    "SELECT body FROM generations WHERE project_id = $1 ORDER BY body->>'createdAt' DESC, id DESC",
    [projectId],
  );
  return rows.map((r) => parsedBody(Generation, r.body, "generation"));
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

async function one<T>(
  q: Queryable,
  schema: z.ZodType<T>,
  what: string,
  sql: string,
  params: unknown[],
) {
  const rows = await q.query<{ body: unknown }>(sql, params);
  return rows[0] === undefined ? null : parsedBody(schema, rows[0].body, what);
}

export const reviewOf = (q: Queryable, projectId: string, revision: number) =>
  one(q, Review, "review", "SELECT body FROM reviews WHERE project_id = $1 AND revision = $2", [
    projectId,
    revision,
  ]);

/** One review per revision (S4); reviewing a revision again changes nothing. */
export async function saveReview(q: Queryable, review: Review): Promise<void> {
  const body = parsedBody(Review, review, "review");
  await q.query(
    "INSERT INTO reviews (project_id, revision, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING",
    [body.projectId, body.revision, asJson(body)],
  );
}

export const previewOf = (q: Queryable, projectId: string, revision: number) =>
  one(q, Preview, "preview", "SELECT body FROM previews WHERE project_id = $1 AND revision = $2", [
    projectId,
    revision,
  ]);

/** A preview is rebuilt on request; the newest build of a revision replaces the row. */
export async function savePreview(q: Queryable, preview: Preview): Promise<void> {
  const body = parsedBody(Preview, preview, "preview");
  await q.query(
    `INSERT INTO previews (project_id, revision, body) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (project_id, revision) DO UPDATE SET body = excluded.body`,
    [body.projectId, body.revision, asJson(body)],
  );
}

export const versionOf = (q: Queryable, projectId: string, version: number) =>
  one(
    q,
    PublishedVersion,
    "published version",
    "SELECT body FROM published_versions WHERE project_id = $1 AND version = $2",
    [projectId, version],
  );

/** Published versions are immutable (Contract §9): inserting an existing number is an error. */
export async function saveVersion(q: Queryable, version: PublishedVersion): Promise<void> {
  const body = parsedBody(PublishedVersion, version, "published version");
  await q.query(
    "INSERT INTO published_versions (project_id, version, body) VALUES ($1, $2, $3::jsonb)",
    [body.projectId, body.version, asJson(body)],
  );
}
