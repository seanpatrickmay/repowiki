import { describe, expect, it } from "vitest";
import type { Job, JobStatus } from "./entities.ts";
import {
  cancelJob,
  createJob,
  failJob,
  heartbeatJob,
  leaseJob,
  type NewJob,
  recordSpend,
  recoverJob,
  retryJob,
  succeedJob,
} from "./jobs.ts";
import type { Result } from "./result.ts";
import { aJob, ids, SHA, T0 } from "./test-fixtures.ts";

const T1 = "2026-10-14T12:01:00Z";
const LATER = "2026-10-14T13:00:00Z";
const LEASE = 120_000;
const newJob: NewJob = {
  id: ids.job,
  projectId: ids.project,
  kind: "generate",
  commitSha: SHA,
  estimateUsdMicros: 400_000,
  capUsdMicros: 600_000,
  now: T0,
};
const running = (patch: Partial<Job> = {}) =>
  aJob({ status: "running", step: "fetch", startedAt: T0, leaseExpiresAt: T1, ...patch });
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.value;
};

describe("creating a job (Contract spec §6.1)", () => {
  it("queues attempt 1 with its estimate and cap", () => {
    expect(createJob(newJob, null)).toEqual({ ok: true, value: { job: aJob(), created: true } });
  });

  it("returns the active job for the same kind and commit, and refuses any other", () => {
    const active = running();
    expect(createJob(newJob, active)).toEqual({ ok: true, value: { job: active, created: false } });
    expect(createJob({ ...newJob, kind: "refresh" }, active)).toEqual({
      ok: false,
      code: "job-active",
    });
    expect(createJob({ ...newJob, commitSha: "c".repeat(40) }, active)).toMatchObject({
      code: "job-active",
    });
  });

  it("ignores a finished job passed as active", () => {
    const done = aJob({ status: "succeeded", finishedAt: T0 });
    expect(createJob(newJob, done)).toMatchObject({ ok: true, value: { created: true } });
  });
});

describe("running a job (Contract spec §6.1)", () => {
  it("leases a queued job and extends the lease as its steps advance", () => {
    const leased = value(leaseJob(aJob(), T0, LEASE));
    expect(leased).toEqual(running({ leaseExpiresAt: "2026-10-14T12:02:00.000Z" }));
    const later = value(heartbeatJob(leased, 1, "write", T1, LEASE));
    expect(later).toMatchObject({ step: "write", leaseExpiresAt: "2026-10-14T12:03:00.000Z" });
    expect(heartbeatJob(later, 1, "index", T1, LEASE)).toMatchObject({
      code: "invalid-transition",
    });
    expect(value(heartbeatJob(later, 1, "write", T1, LEASE)).step).toBe("write");
  });

  it("adds spend up to the cap and refuses to pass it", () => {
    const job = running({ spentUsdMicros: 500_000 });
    expect(value(recordSpend(job, 1, 100_000)).spentUsdMicros).toBe(600_000);
    expect(recordSpend(job, 1, 100_001)).toEqual({ ok: false, code: "job-cost-cap" });
    expect(recordSpend(job, 1, -1)).toMatchObject({ code: "invalid-input" });
    expect(recordSpend(job, 1, 0.5)).toMatchObject({ code: "invalid-input" });
  });

  it("succeeds or fails with a code, clearing the lease", () => {
    expect(value(succeedJob(running(), 1, T1))).toMatchObject({
      status: "succeeded",
      finishedAt: T1,
      leaseExpiresAt: null,
    });
    expect(value(failJob(running(), 1, "repo-too-large", T1))).toMatchObject({
      status: "failed",
      refusal: "repo-too-large",
      finishedAt: T1,
      leaseExpiresAt: null,
    });
  });
});

describe("recovering and retrying (Contract spec §6.1)", () => {
  it("requeues a job whose lease expired, up to three attempts", () => {
    expect(recoverJob(running(), T0)).toMatchObject({ code: "invalid-transition" });
    expect(value(recoverJob(running(), LATER))).toMatchObject({
      status: "queued",
      attempt: 2,
      step: null,
      leaseExpiresAt: null,
    });
    expect(value(recoverJob(running({ attempt: 3 }), LATER))).toMatchObject({
      status: "failed",
      refusal: "job-interrupted",
      attempt: 3,
      finishedAt: LATER,
    });
  });

  it("retries only a retryable failure with attempts left, keeping what was spent", () => {
    const failed = aJob({ status: "failed", refusal: "job-failed", spentUsdMicros: 90_000 });
    expect(value(retryJob(failed))).toMatchObject({
      status: "queued",
      attempt: 2,
      refusal: null,
      spentUsdMicros: 90_000,
      finishedAt: null,
    });
    expect(retryJob({ ...failed, attempt: 3 })).toMatchObject({ code: "invalid-transition" });
    expect(retryJob({ ...failed, refusal: "job-cost-cap" })).toMatchObject({
      code: "invalid-transition",
    });
  });

  it("cancels a queued or running job", () => {
    expect(value(cancelJob(aJob(), T1))).toMatchObject({ status: "cancelled", finishedAt: T1 });
    expect(value(cancelJob(running(), T1))).toMatchObject({
      status: "cancelled",
      leaseExpiresAt: null,
    });
  });
});

describe("every (status, event) pair (Contract spec §6.1)", () => {
  const events: Record<string, (job: Job) => Result<Job>> = {
    lease: (j) => leaseJob(j, T0, LEASE),
    heartbeat: (j) => heartbeatJob(j, 1, "fetch", T0, LEASE),
    spend: (j) => recordSpend(j, 1, 1),
    succeed: (j) => succeedJob(j, 1, T1),
    fail: (j) => failJob(j, 1, "job-failed", T1),
    recover: (j) => recoverJob(j, LATER),
    retry: (j) => retryJob(j),
    cancel: (j) => cancelJob(j, T1),
  };
  const allowed: Record<JobStatus, string[]> = {
    queued: ["lease", "cancel"],
    running: ["heartbeat", "spend", "succeed", "fail", "recover", "cancel"],
    succeeded: [],
    failed: ["retry"],
    cancelled: [],
  };
  const sample: Record<JobStatus, Job> = {
    queued: aJob(),
    running: running(),
    succeeded: aJob({ status: "succeeded", finishedAt: T1 }),
    failed: aJob({ status: "failed", refusal: "job-failed", finishedAt: T1 }),
    cancelled: aJob({ status: "cancelled", finishedAt: T1 }),
  };

  for (const status of Object.keys(sample) as JobStatus[]) {
    for (const [event, run] of Object.entries(events)) {
      const expected = allowed[status].includes(event);
      it(`${status} + ${event} → ${expected ? "allowed" : "invalid-transition"}`, () => {
        const result = run(sample[status]);
        if (expected) expect(result.ok).toBe(true);
        else expect(result).toEqual({ ok: false, code: "invalid-transition" });
      });
    }
  }
});

describe("fencing a worker to its attempt (final review C3)", () => {
  it("refuses a stale worker's heartbeat, spend, success and failure after recovery", () => {
    const first = value(leaseJob(aJob(), T0, LEASE));
    const requeued = value(recoverJob(first, LATER));
    const second = value(leaseJob(requeued, LATER, LEASE));
    expect(second.attempt).toBe(2);
    const stale = { ok: false, code: "invalid-transition", detail: "stale attempt" };
    expect(heartbeatJob(second, 1, "index", LATER, LEASE)).toEqual(stale);
    expect(recordSpend(second, 1, 10)).toEqual(stale);
    expect(succeedJob(second, 1, LATER)).toEqual(stale);
    expect(failJob(second, 1, "job-failed", LATER)).toEqual(stale);
    expect(value(heartbeatJob(second, 2, "index", LATER, LEASE)).step).toBe("index");
    expect(value(succeedJob(second, 2, LATER)).status).toBe("succeeded");
  });

  it("refuses a heartbeat once the lease has run out", () => {
    expect(heartbeatJob(running(), 1, "index", LATER, LEASE)).toEqual({
      ok: false,
      code: "invalid-transition",
      detail: "lease expired",
    });
  });
});
