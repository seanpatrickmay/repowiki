import { JOB_STEPS, type Job, type JobKind, type JobStatus, type JobStep } from "./entities.ts";
import { PLATFORM } from "./limits.ts";
import { REFUSALS, type RefusalCode } from "./refusals.ts";
import { ok, type Result, refused } from "./result.ts";

export interface NewJob {
  id: string;
  projectId: string;
  kind: JobKind;
  commitSha: string;
  estimateUsdMicros: number;
  /** From `jobCap` (§10), computed by the caller with the account's month so far. */
  capUsdMicros: number;
  now: string;
}

export function isTerminal(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

const after = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();
const invalid = () => refused("invalid-transition");

/**
 * A new queued job (§6.1). `active` is the project's non-terminal job, if any: the same kind
 * and commit returns it unchanged (an idempotent retry of the request); anything else is
 * `job-active`.
 */
export function createJob(
  input: NewJob,
  active: Job | null,
): Result<{ job: Job; created: boolean }> {
  if (active !== null && !isTerminal(active.status)) {
    if (active.kind === input.kind && active.commitSha === input.commitSha) {
      return ok({ job: active, created: false });
    }
    return refused("job-active");
  }
  const job: Job = {
    id: input.id,
    projectId: input.projectId,
    kind: input.kind,
    commitSha: input.commitSha,
    status: "queued",
    step: null,
    attempt: 1,
    leaseExpiresAt: null,
    estimateUsdMicros: input.estimateUsdMicros,
    capUsdMicros: input.capUsdMicros,
    spentUsdMicros: 0,
    refusal: null,
    createdAt: input.now,
    startedAt: null,
    finishedAt: null,
  };
  return ok({ job, created: true });
}

/** A worker takes a queued job. */
export function leaseJob(job: Job, now: string, leaseMs: number): Result<Job> {
  if (job.status !== "queued") return invalid();
  return ok({
    ...job,
    status: "running",
    step: "fetch",
    leaseExpiresAt: after(now, leaseMs),
    startedAt: job.startedAt ?? now,
  });
}

/**
 * The worker holding `attempt` may act on a running job; a worker whose lease expired and whose
 * job was recovered holds an older attempt and is refused, so two workers never share one job.
 */
function fenced(job: Job, attempt: number): Result<Job> {
  if (job.status !== "running") return invalid();
  if (job.attempt !== attempt) return refused("invalid-transition", "stale attempt");
  return ok(job);
}

/** The worker is alive and at `step`; steps only move forward, and only within the lease. */
export function heartbeatJob(
  job: Job,
  attempt: number,
  step: JobStep,
  now: string,
  leaseMs: number,
): Result<Job> {
  const held = fenced(job, attempt);
  if (!held.ok) return held;
  if (job.leaseExpiresAt !== null && Date.parse(now) > Date.parse(job.leaseExpiresAt)) {
    return refused("invalid-transition", "lease expired");
  }
  if (job.step !== null && JOB_STEPS.indexOf(step) < JOB_STEPS.indexOf(job.step)) return invalid();
  return ok({ ...job, step, leaseExpiresAt: after(now, leaseMs) });
}

/** Money the job's model calls cost; the job stops rather than pass its cap. */
export function recordSpend(job: Job, attempt: number, usdMicros: number): Result<Job> {
  const held = fenced(job, attempt);
  if (!held.ok) return held;
  if (!Number.isInteger(usdMicros) || usdMicros < 0) return refused("invalid-input", "usdMicros");
  if (job.spentUsdMicros + usdMicros > job.capUsdMicros) return refused("job-cost-cap");
  return ok({ ...job, spentUsdMicros: job.spentUsdMicros + usdMicros });
}

export function succeedJob(job: Job, attempt: number, now: string): Result<Job> {
  const held = fenced(job, attempt);
  if (!held.ok) return held;
  return ok({ ...job, status: "succeeded", leaseExpiresAt: null, finishedAt: now });
}

export function failJob(job: Job, attempt: number, code: RefusalCode, now: string): Result<Job> {
  const held = fenced(job, attempt);
  if (!held.ok) return held;
  return ok({ ...job, status: "failed", refusal: code, leaseExpiresAt: null, finishedAt: now });
}

/** A running job whose lease ran out goes back on the queue, or fails after its last attempt. */
export function recoverJob(job: Job, now: string): Result<Job> {
  if (job.status !== "running" || job.leaseExpiresAt === null) return invalid();
  if (Date.parse(job.leaseExpiresAt) > Date.parse(now)) return invalid();
  if (job.attempt >= PLATFORM.jobMaxAttempts) {
    return failJob(job, job.attempt, "job-interrupted", now);
  }
  return ok({
    ...job,
    status: "queued",
    attempt: job.attempt + 1,
    step: null,
    leaseExpiresAt: null,
  });
}

/** The author retries a retryable failure; money already spent stays counted against the cap. */
export function retryJob(job: Job): Result<Job> {
  if (job.status !== "failed" || job.refusal === null) return invalid();
  // A failed correction has forgotten its notes (ADR-0023): the author starts a new one.
  if (job.kind === "correct") return invalid();
  if (!REFUSALS[job.refusal].retryable || job.attempt >= PLATFORM.jobMaxAttempts) return invalid();
  return ok({
    ...job,
    status: "queued",
    attempt: job.attempt + 1,
    step: null,
    refusal: null,
    finishedAt: null,
  });
}

export function cancelJob(job: Job, now: string): Result<Job> {
  if (job.status !== "queued" && job.status !== "running") return invalid();
  return ok({ ...job, status: "cancelled", leaseExpiresAt: null, finishedAt: now });
}
