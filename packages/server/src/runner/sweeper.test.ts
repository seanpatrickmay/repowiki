import { type Account, type Job, leaseJob } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import type { Db } from "../db/db.ts";
import type { GitHubRepo } from "../github/api.ts";
import { FAKE_REPO, FAKE_USER } from "../github/fake.ts";
import { fakeAnthropicFetch } from "../proxy/fake-anthropic.ts";
import { testDeps } from "../routes/test-app.ts";
import { signIn } from "../store/accounts.ts";
import { issueToken, jobById, openReservations, saveJob, tokenJob } from "../store/jobs.ts";
import { startGeneration } from "../store/start.ts";
import { recordingRunner, type StartRequest } from "./runner.ts";
import { sweep } from "./sweeper.ts";

let deps: Deps;
let started: StartRequest[];
let clock = "2026-10-14T12:00:00.000Z";
let job: Job;
let firstToken: string;

/** A generation started the way `POST /projects` starts one: a job and its first token. */
async function startOne(): Promise<void> {
  const signed = await signIn(
    deps.db,
    {
      githubUserId: FAKE_USER.id,
      login: FAKE_USER.login,
      displayName: FAKE_USER.name,
      githubCreatedAt: FAKE_USER.created_at,
    },
    { newAccountId: deps.newId(), allowNew: () => true, now: clock },
  );
  const result = await startGeneration(deps.db, {
    account: signed?.account as Account,
    facts: {
      checkedAt: clock,
      githubUserId: FAKE_USER.id,
      githubRepoId: FAKE_REPO.id,
      fullName: FAKE_REPO.full_name,
      visibility: "public",
      isFork: false,
      permission: "admin",
      authoredCommits: 42,
      indexedFiles: null,
      tokenValid: true,
    },
    repo: FAKE_REPO as GitHubRepo,
    commitSha: "d".repeat(40),
    commitShas: [],
    now: clock,
    newId: deps.newId,
  });
  if (!result.ok) throw new Error(result.code);
  job = result.value.job;
  firstToken = result.value.token ?? "";
}

beforeEach(async () => {
  const recording = recordingRunner();
  started = recording.started;
  clock = "2026-10-14T12:00:00.000Z";
  deps = await testDeps({ runner: recording.runner, now: () => clock });
  await startOne();
});
afterEach(async () => deps.db.close());

const theJob = async () => jobById(deps.db, job.id);
const reserve = (usd: number) =>
  deps.db.query(
    "INSERT INTO reservations (id, job_id, attempt, usd_micros) VALUES ($1, $2, 1, $3)",
    [deps.newId(), job.id, usd],
  );

describe("the sweeper (spec 2 S16)", () => {
  it("leaves a fresh queued job and a live lease alone", async () => {
    expect(await sweep(deps)).toEqual({ recovered: 0, restarted: 0, abandoned: 0 });
    expect(started).toEqual([]);
  });

  it("restarts a queued job nobody leased, then gives up after three starts", async () => {
    clock = "2026-10-14T12:06:00.000Z";
    expect(await sweep(deps)).toMatchObject({ restarted: 1 });
    expect(started).toHaveLength(1);
    clock = "2026-10-14T12:12:00.000Z";
    expect(await sweep(deps)).toMatchObject({ restarted: 1 });
    clock = "2026-10-14T12:18:00.000Z";
    expect(await sweep(deps)).toMatchObject({ abandoned: 1 });
    expect(started).toHaveLength(2);
    expect(await theJob()).toMatchObject({ status: "failed", refusal: "job-interrupted" });
    expect(await tokenJob(deps.db, started[1]?.token ?? "")).toBeNull();
  });

  it("revokes the old token before a restart issues a new one (one worker per attempt)", async () => {
    clock = "2026-10-14T12:06:00.000Z";
    await sweep(deps);
    expect(await tokenJob(deps.db, firstToken)).toBeNull();
    expect(await tokenJob(deps.db, started[0]?.token ?? "")).toMatchObject({ attempt: 1 });
  });

  it("starts at once a queued job that never got a token (the start failed)", async () => {
    await deps.db.query("DELETE FROM job_tokens");
    expect(await sweep(deps)).toMatchObject({ restarted: 1 });
    expect(started).toEqual([{ jobId: job.id, attempt: 1, token: expect.any(String) }]);
  });

  it("recovers an expired lease onto a new attempt with a new token", async () => {
    const leased = leaseJob(job, clock, 60_000);
    if (!leased.ok) throw new Error("lease");
    await saveJob(deps.db, leased.value);
    clock = "2026-10-14T12:05:00.000Z";
    expect(await sweep(deps)).toMatchObject({ recovered: 1 });
    expect(await theJob()).toMatchObject({ status: "queued", attempt: 2 });
    expect(started.at(-1)).toMatchObject({ attempt: 2 });
    expect(await tokenJob(deps.db, firstToken)).toBeNull();
  });

  it("keeps sweeping when one start fails", async () => {
    // A second queued job: the first start in the pass fails, the second must still happen.
    const other = { ...job, id: "00000000-0000-4000-8000-0000000000aa", projectId: job.id };
    await saveJob(deps.db, other);
    await issueToken(deps.db, other.id, 1, clock);
    const tried: string[] = [];
    deps = {
      ...deps,
      runner: {
        start: async (request) => {
          tried.push(request.jobId);
          if (tried.length === 1) throw new Error("machine refused");
          started.push(request);
        },
      },
    };
    clock = "2026-10-14T12:06:00.000Z";
    expect(await sweep(deps)).toMatchObject({ restarted: 2 });
    expect(tried).toHaveLength(2);
    expect(started.map((s) => s.jobId)).toEqual([tried[1]]);
  });

  it("charges a recovered attempt's open reservations", async () => {
    const leased = leaseJob(job, clock, 60_000);
    if (!leased.ok) throw new Error("lease");
    await saveJob(deps.db, leased.value);
    await reserve(1234);
    clock = "2026-10-14T12:05:00.000Z";
    expect(await sweep(deps)).toMatchObject({ recovered: 1 });
    expect(await theJob()).toMatchObject({ status: "queued", attempt: 2, spentUsdMicros: 1234 });
    expect(await openReservations(deps.db, job.id)).toBe(0);
  });

  it("cancels a recovered attempt's open batches upstream (fresh review I3)", async () => {
    const upstream = fakeAnthropicFetch();
    deps = {
      ...deps,
      anthropic: { url: "https://api.anthropic.test", key: "sk-real", fetch: upstream.fetch },
    };
    const leased = leaseJob(job, clock, 60_000);
    if (!leased.ok) throw new Error("lease");
    await saveJob(deps.db, leased.value);
    await deps.db.query(
      "INSERT INTO reservations (id, job_id, attempt, usd_micros, batch, batch_id) VALUES ($1, $2, 1, 500, true, 'msgbatch_9')",
      [deps.newId(), job.id],
    );
    clock = "2026-10-14T12:05:00.000Z";
    expect(await sweep(deps)).toMatchObject({ recovered: 1 });
    const cancels = upstream.calls.filter((c) => c.url.endsWith("/cancel"));
    expect(cancels.map((c) => c.url)).toEqual([
      "https://api.anthropic.test/v1/messages/batches/msgbatch_9/cancel",
    ]);
  });

  it("leaves a job's reservations open when a heartbeat renewed its lease before the lock", async () => {
    // Staged by hand (PGlite runs one transaction at a time): the sweep's SELECT sees the expired
    // lease, then a heartbeat lands before recover() locks the row.
    const leased = leaseJob(job, clock, 60_000);
    if (!leased.ok) throw new Error("lease");
    await saveJob(deps.db, leased.value);
    await reserve(1234);
    clock = "2026-10-14T12:05:00.000Z";
    const db = deps.db;
    const racing: Db = {
      ...db,
      query: async (sql, params) => {
        const rows = await db.query(sql, params);
        if (sql.includes("lease_expires_at <=")) {
          await saveJob(db, { ...leased.value, leaseExpiresAt: "2026-10-14T12:07:00.000Z" });
        }
        return rows as never;
      },
    };
    expect(await sweep({ ...deps, db: racing })).toMatchObject({ recovered: 0 });
    expect(await theJob()).toMatchObject({ status: "running", attempt: 1, spentUsdMicros: 0 });
    expect(await openReservations(deps.db, job.id)).toBe(1234);
  });
});
