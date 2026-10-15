import { isTerminal, type Job } from "@repowiki/hosted";
import type { Queryable } from "../db/db.ts";
import { HttpError } from "../http/body.ts";
import { jobById, type TokenHolder, tokenJob } from "../store/jobs.ts";

export interface Held {
  job: Job;
  holder: TokenHolder;
  token: string;
}

const invalid = () => new HttpError(401, "This job token is not valid.");

/**
 * The job a worker's token speaks for (spec 2 §6): a live token for the job's current attempt
 * while it is queued or running, and while it runs, only the token that leased it (A5). 401 for
 * any other token, 409 for a second worker on a leased attempt. `forUpdate` locks the job row.
 */
export async function heldJob(
  q: Queryable,
  token: string | null,
  forUpdate: boolean,
): Promise<Held> {
  if (token === null) throw invalid();
  const unlocked = await tokenJob(q, token);
  if (unlocked === null) throw invalid();
  const job = await jobById(q, unlocked.jobId, forUpdate);
  // A token the sweeper revoked (or a lease marked) while this waited on the lock is read again.
  const holder = forUpdate ? await tokenJob(q, token) : unlocked;
  if (holder === null || holder.jobId !== unlocked.jobId) throw invalid();
  if (job === null || job.attempt !== holder.attempt || isTerminal(job.status)) throw invalid();
  if (job.status === "running" && !holder.leased) {
    throw new HttpError(409, "Another worker holds this job.");
  }
  return { job, holder, token };
}

/** A job token is 32 random bytes in base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function tokenFrom(value: string | string[] | undefined, prefix = ""): string | null {
  if (typeof value !== "string" || !value.startsWith(prefix)) return null;
  const token = value.slice(prefix.length);
  return TOKEN.test(token) ? token : null;
}
