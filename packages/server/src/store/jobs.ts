import { GitSha, Sha256Hex } from "@repowiki/core";
import { CORRECTION, Job, Plan, recordSpend } from "@repowiki/hosted";
import { z } from "zod";
import { randomToken, sha256Hex } from "../crypto.ts";
import type { Queryable } from "../db/db.ts";
import { asJson, parsedBody } from "./rows.ts";

/** What a worker needs that the Contract's Job does not hold (spec 2 §6). */
export const JobSpec = z.strictObject({
  repo: z.strictObject({
    githubRepoId: z.int().positive(),
    fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    name: z.string().min(1),
    cloneUrl: z.string().regex(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\.git$/),
    sizeKb: z.number().nonnegative(),
  }),
  author: z.strictObject({
    login: z.string().min(1).max(39),
    githubUserId: z.int().positive(),
    commitShas: z.array(GitSha).max(100),
  }),
  plan: Plan,
  export: z.strictObject({ key: z.string().min(1), hash: Sha256Hex }).nullable(),
  /**
   * A correction job's sentences (ADR-0023): the generation corrected, each item's note until the
   * job ends (then null: saveJob forgets it), and each item's outcome once it succeeded.
   */
  correction: z
    .strictObject({
      generationId: z.uuid(),
      items: z
        .array(
          z.strictObject({
            page: z.string().min(1).max(200),
            claimId: z.string().min(1).max(200),
            note: z.string().max(CORRECTION.noteLength).nullable(),
          }),
        )
        .min(1)
        .max(CORRECTION.items),
      outcomes: z
        .array(
          z.strictObject({
            page: z.string().min(1).max(200),
            claimId: z.string().min(1).max(200),
            outcome: z.enum(["rewritten", "removed", "refused"]),
          }),
        )
        .max(CORRECTION.items)
        .nullable(),
    })
    .optional(),
});
export type JobSpec = z.infer<typeof JobSpec>;

const lock = (forUpdate: boolean) => (forUpdate ? " FOR UPDATE" : "");
const parsed = (rows: { body: unknown }[]) =>
  rows[0] === undefined ? null : parsedBody(Job, rows[0].body, "job");

export async function jobById(q: Queryable, id: string, forUpdate = false): Promise<Job | null> {
  return parsed(
    await q.query<{ body: unknown }>(`SELECT body FROM jobs WHERE id = $1${lock(forUpdate)}`, [id]),
  );
}

/** The project's queued or running job, if any (at most one: `jobs_one_active`). */
export async function activeJob(
  q: Queryable,
  projectId: string,
  forUpdate = false,
): Promise<Job | null> {
  return parsed(
    await q.query<{ body: unknown }>(
      `SELECT body FROM jobs WHERE project_id = $1 AND status IN ('queued', 'running')${lock(forUpdate)}`,
      [projectId],
    ),
  );
}

export async function jobsOf(q: Queryable, projectId: string): Promise<Job[]> {
  const rows = await q.query<{ body: unknown }>(
    "SELECT body FROM jobs WHERE project_id = $1 ORDER BY body->>'createdAt' DESC, id",
    [projectId],
  );
  return rows.map((r) => parsedBody(Job, r.body, "job"));
}

export async function saveJob(q: Queryable, job: Job): Promise<void> {
  const body = parsedBody(Job, job, "job");
  await q.query(
    `INSERT INTO jobs (id, project_id, status, lease_expires_at, body) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status,
       lease_expires_at = excluded.lease_expires_at, body = excluded.body`,
    [body.id, body.projectId, body.status, body.leaseExpiresAt, asJson(body)],
  );
  // A correction's notes are the student's and live only while it runs (ADR-0023).
  if (body.kind === "correct" && body.status !== "queued" && body.status !== "running") {
    await q.query(
      `UPDATE job_specs SET body = jsonb_set(body, '{correction,items}', (
         SELECT jsonb_agg(jsonb_set(item, '{note}', 'null'::jsonb))
         FROM jsonb_array_elements(body->'correction'->'items') item))
       WHERE job_id = $1 AND body ? 'correction'`,
      [body.id],
    );
  }
}

export async function saveJobSpec(q: Queryable, jobId: string, spec: JobSpec): Promise<void> {
  const body = parsedBody(JobSpec, spec, "job spec");
  await q.query(
    `INSERT INTO job_specs (job_id, body) VALUES ($1, $2::jsonb)
     ON CONFLICT (job_id) DO UPDATE SET body = excluded.body`,
    [jobId, asJson(body)],
  );
}

export async function jobSpec(q: Queryable, jobId: string): Promise<JobSpec | null> {
  const rows = await q.query<{ body: unknown }>("SELECT body FROM job_specs WHERE job_id = $1", [
    jobId,
  ]);
  return rows[0] === undefined ? null : parsedBody(JobSpec, rows[0].body, "job spec");
}

/** A fresh single-use secret for one attempt of one job; only its hash is kept (spec 2 §10). */
export async function issueToken(
  q: Queryable,
  jobId: string,
  attempt: number,
  now: string,
): Promise<string> {
  const token = randomToken();
  await q.query(
    "INSERT INTO job_tokens (token_hash, job_id, attempt, issued_at) VALUES ($1, $2, $3, $4)",
    [sha256Hex(token), jobId, attempt, now],
  );
  return token;
}

/** The job and attempt a live token was issued for, and whether it leased that attempt. */
export interface TokenHolder {
  jobId: string;
  attempt: number;
  leased: boolean;
}

/** The holder of a token, or null for an unknown or revoked token. */
export async function tokenJob(q: Queryable, token: string): Promise<TokenHolder | null> {
  const rows = await q.query<{ job_id: string; attempt: number; leased: boolean }>(
    "SELECT job_id, attempt, leased FROM job_tokens WHERE token_hash = $1 AND NOT revoked",
    [sha256Hex(token)],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { jobId: row.job_id, attempt: Number(row.attempt), leased: row.leased };
}

/** The token that leased its job's attempt; only it may act on the running job (M14c A5). */
export async function markLeased(q: Queryable, token: string): Promise<void> {
  await q.query("UPDATE job_tokens SET leased = true WHERE token_hash = $1", [sha256Hex(token)]);
}

/** How many tokens an attempt has had and when the last was issued (the sweeper's restart bound). */
export async function tokensIssued(
  q: Queryable,
  jobId: string,
  attempt: number,
): Promise<{ count: number; last: Date | null }> {
  const rows = await q.query<{ count: string | number; last: Date | null }>(
    "SELECT count(*) AS count, max(issued_at) AS last FROM job_tokens WHERE job_id = $1 AND attempt = $2",
    [jobId, attempt],
  );
  return { count: Number(rows[0]?.count ?? 0), last: rows[0]?.last ?? null };
}

/**
 * Every token of the job stops working: it ended, its attempt was recovered, or it is restarted
 * (spec 2 §6). Rows stay, so `tokensIssued` still counts the attempt's starts.
 */
export async function revokeTokens(q: Queryable, jobId: string): Promise<void> {
  await q.query("UPDATE job_tokens SET revoked = true WHERE job_id = $1", [jobId]);
}

/** The job's reservations the proxy has not settled yet, in micro-dollars. */
export async function openReservations(q: Queryable, jobId: string): Promise<number> {
  const rows = await q.query<{ usd: string | number }>(
    "SELECT COALESCE(sum(usd_micros), 0) AS usd FROM reservations WHERE job_id = $1 AND NOT settled",
    [jobId],
  );
  return Number(rows[0]?.usd ?? 0);
}

/** The upstream ids of a job's batches still open: what to cancel once the job ends (S11). */
export async function openBatchIds(q: Queryable, jobId: string): Promise<string[]> {
  const rows = await q.query<{ batch_id: string }>(
    `SELECT batch_id FROM reservations
     WHERE job_id = $1 AND batch AND NOT settled AND batch_id IS NOT NULL ORDER BY batch_id`,
    [jobId],
  );
  return rows.map((r) => r.batch_id);
}

/**
 * A job about to stop: every open reservation becomes spend in full, because the real cost of a
 * batch whose results were never read is unknown (Contract C8; spec 2 §6). Each is recorded as
 * its real cost at `now`; the job's spend never passes the cap, which the Job schema forbids.
 */
export async function settleOpen(q: Queryable, job: Job, now: string): Promise<Job> {
  const open = await openReservations(q, job.id);
  await q.query(
    `UPDATE reservations SET settled = true, actual_usd_micros = usd_micros, settled_at = $2
     WHERE job_id = $1 AND NOT settled`,
    [job.id, now],
  );
  if (open === 0 || job.status !== "running") return job;
  const spend = Math.min(open, job.capUsdMicros - job.spentUsdMicros);
  const spent = recordSpend(job, job.attempt, spend);
  return spent.ok ? spent.value : job;
}
