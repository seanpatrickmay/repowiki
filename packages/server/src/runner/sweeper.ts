import { failJob, leaseJob, recoverJob } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Db } from "../db/db.ts";
import { cancelBatches } from "../proxy/cancel.ts";
import {
  issueToken,
  jobById,
  openBatchIds,
  revokeTokens,
  saveJob,
  settleOpen,
  tokensIssued,
} from "../store/jobs.ts";
import type { JobRunner, StartRequest } from "./runner.ts";

/** A queued job whose worker has not leased it this long after its token was issued is restarted. */
export const RESTART_AFTER_MS = 5 * 60_000;
/** Starts (tokens) one attempt may have before the sweeper gives the job up. */
export const MAX_STARTS_PER_ATTEMPT = 3;

export interface SweepDeps {
  db: Db;
  runner: JobRunner;
  now: () => string;
  log?: (line: object) => void;
  /** Where a recovered attempt's open batches are cancelled; none are without it. */
  anthropic?: Deps["anthropic"];
}

export interface Swept {
  recovered: number;
  restarted: number;
  abandoned: number;
}

/** A running job whose lease ran out: open spend charged, then back on the queue or failed. */
async function recover(
  deps: SweepDeps,
  id: string,
  now: string,
  ended: string[],
): Promise<StartRequest | "failed" | null> {
  return deps.db.transaction(async (tx) => {
    const job = await jobById(tx, id, true);
    if (job === null || job.status !== "running") return null;
    // A heartbeat may have renewed the lease since the sweep's SELECT: check before settling.
    if (!recoverJob(job, now).ok) return null;
    const batches = await openBatchIds(tx, id);
    const next = recoverJob(await settleOpen(tx, job, now), now);
    if (!next.ok) return null;
    ended.push(...batches);
    await saveJob(tx, next.value);
    await revokeTokens(tx, id);
    if (next.value.status !== "queued") return "failed";
    const { attempt } = next.value;
    return { jobId: id, attempt, token: await issueToken(tx, id, attempt, now) };
  });
}

/** A queued job nobody leased: started again with a fresh token, or failed after three starts. */
async function restart(
  deps: SweepDeps,
  id: string,
  now: string,
): Promise<StartRequest | "abandoned" | null> {
  return deps.db.transaction(async (tx) => {
    const job = await jobById(tx, id, true);
    if (job === null || job.status !== "queued") return null;
    const issued = await tokensIssued(tx, id, job.attempt);
    if (issued.last !== null && Date.parse(now) - issued.last.getTime() < RESTART_AFTER_MS) {
      return null;
    }
    // One worker per attempt (A5): the old token dies before a new one exists.
    await revokeTokens(tx, id);
    if (issued.count >= MAX_STARTS_PER_ATTEMPT) {
      // The Contract fails only running jobs: lease it to the system, then fail it.
      const leased = leaseJob(job, now, 0);
      const failed = leased.ok
        ? failJob(leased.value, job.attempt, "job-interrupted", now)
        : leased;
      if (!failed.ok) return null;
      await saveJob(tx, failed.value);
      return "abandoned";
    }
    return { jobId: id, attempt: job.attempt, token: await issueToken(tx, id, job.attempt, now) };
  });
}

/** One pass: recover expired leases, restart stuck queued jobs, abandon hopeless ones (S16). */
export async function sweep(deps: SweepDeps): Promise<Swept> {
  const now = deps.now();
  const swept: Swept = { recovered: 0, restarted: 0, abandoned: 0 };
  const toStart: StartRequest[] = [];
  const expired = await deps.db.query<{ id: string }>(
    "SELECT id FROM jobs WHERE status = 'running' AND lease_expires_at <= $1",
    [now],
  );
  const ended: string[] = [];
  for (const { id } of expired) {
    const outcome = await recover(deps, id, now, ended);
    if (outcome !== null) swept.recovered++;
    if (outcome !== null && outcome !== "failed") toStart.push(outcome);
  }
  // The old attempt's batches: nothing will read their results now (fresh review I3).
  if (deps.anthropic !== undefined) {
    await cancelBatches(deps.anthropic, ended, deps.log ?? (() => undefined));
  }
  const queued = await deps.db.query<{ id: string }>(
    "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id",
  );
  for (const { id } of queued) {
    if (toStart.some((s) => s.jobId === id)) continue;
    const outcome = await restart(deps, id, now);
    if (outcome === "abandoned") swept.abandoned++;
    else if (outcome !== null) {
      swept.restarted++;
      toStart.push(outcome);
    }
  }
  for (const start of toStart) {
    // A failed start leaves the job queued with its token; the next pass restarts it.
    await deps.runner.start(start).catch((error: unknown) => {
      deps.log?.({ sweep: "start-failed", job: start.jobId, error: nameOf(error) });
    });
  }
  return swept;
}

const nameOf = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/** Sweep every `intervalMs` until the returned function is called. */
export function startSweeper(deps: SweepDeps, intervalMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweep(deps)
      .then((result) => {
        if (result.recovered + result.restarted + result.abandoned > 0)
          deps.log?.({ sweep: result });
      })
      .catch((error: unknown) => deps.log?.({ sweep: "failed", error: nameOf(error) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
