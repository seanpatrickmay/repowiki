import { type Account, type Job, leaseJob } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import type { GitHubRepo } from "../github/api.ts";
import { FAKE_REPO, FAKE_USER } from "../github/fake.ts";
import { testDeps } from "../routes/test-app.ts";
import { signIn } from "../store/accounts.ts";
import { issueToken, jobById, saveJob, tokenJob } from "../store/jobs.ts";
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
}

beforeEach(async () => {
  const recording = recordingRunner();
  started = recording.started;
  clock = "2026-10-14T12:00:00.000Z";
  deps = await testDeps({ runner: recording.runner, now: () => clock });
  await startOne();
  firstToken = await issueToken(deps.db, job.id, job.attempt, clock);
});
afterEach(async () => deps.db.close());

const theJob = async () => jobById(deps.db, job.id);

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
    deps = {
      ...deps,
      runner: {
        start: async () => {
          throw new Error("machine refused");
        },
      },
    };
    clock = "2026-10-14T12:06:00.000Z";
    expect(await sweep(deps)).toMatchObject({ restarted: 1 });
  });
});
