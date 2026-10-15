import type { Account, Job } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import type { GitHubRepo } from "../github/api.ts";
import { FAKE_REPO, FAKE_USER } from "../github/fake.ts";
import { signIn } from "./accounts.ts";
import { saveJob } from "./jobs.ts";
import { platformDayUsdMicros, usageFor } from "./projects.ts";
import { startGeneration } from "./start.ts";
import { freshDb } from "./test-db.ts";

// The job is created late on the last day of September; "now" is early on 1 October.
const CREATED = "2026-09-30T23:50:00.000Z";
const NOW = "2026-10-01T00:30:00.000Z";
const CAP = 1_000_000;
let db: Db;
let account: Account;
let job: Job;
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

async function reservation(usd: number, settled: { actual: number; at: string } | null) {
  await db.query(
    `INSERT INTO reservations (id, job_id, attempt, usd_micros, settled, actual_usd_micros, settled_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6)`,
    [newId(), job.id, usd, settled !== null, settled?.actual ?? null, settled?.at ?? null],
  );
}
const month = async () => (await usageFor(db, account.id, NOW)).monthUsdMicros;
const day = async () => platformDayUsdMicros(db, NOW);

beforeEach(async () => {
  db = await freshDb();
  const signed = await signIn(
    db,
    {
      githubUserId: FAKE_USER.id,
      login: FAKE_USER.login,
      displayName: "Demo",
      githubCreatedAt: FAKE_USER.created_at,
    },
    { newAccountId: newId(), allowNew: () => true, now: CREATED },
  );
  account = signed?.account as Account;
  const started = await startGeneration(db, {
    account,
    facts: {
      checkedAt: CREATED,
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
    commitSha: "c".repeat(40),
    commitShas: [],
    now: CREATED,
    newId,
  });
  if (!started.ok) throw new Error(started.code);
  job = started.value.job;
});
afterEach(async () => db.close());

describe("usage counts real spend by when it settled (spec 2 S11, S15)", () => {
  it("counts an unfinished job's cap in the period it was created in", async () => {
    expect(await usageFor(db, account.id, CREATED)).toMatchObject({
      monthUsdMicros: CAP,
      platformDayUsdMicros: CAP,
    });
    expect(await month()).toBe(0);
    expect(await day()).toBe(0);
  });

  it("counts an unfinished job's real spend past its cap, and its open reservations, now", async () => {
    await reservation(400_000, { actual: 300_000, at: "2026-09-30T23:55:00.000Z" });
    await reservation(900_000, { actual: 1_200_000, at: "2026-10-01T00:10:00.000Z" });
    await reservation(50_000, null);
    // September: the cap, since its spend there (300,000) is below it.
    expect((await usageFor(db, account.id, CREATED)).monthUsdMicros).toBe(CAP);
    // October: what settled in October plus what is still open.
    expect(await month()).toBe(1_250_000);
    expect(await day()).toBe(1_250_000);
  });

  it("counts a finished job's settled actual costs, not its capped spend, by settled time", async () => {
    await reservation(400_000, { actual: 300_000, at: "2026-09-30T23:55:00.000Z" });
    await reservation(900_000, { actual: 1_500_000, at: "2026-10-01T00:10:00.000Z" });
    await saveJob(db, {
      ...job,
      status: "failed",
      refusal: "job-cost-cap",
      spentUsdMicros: CAP,
      finishedAt: "2026-10-01T00:10:00.000Z",
    });
    expect(await month()).toBe(1_500_000);
    expect(await day()).toBe(1_500_000);
    expect((await usageFor(db, account.id, "2026-09-30T23:59:00.000Z")).monthUsdMicros).toBe(
      300_000,
    );
  });

  it("falls back to a finished job's spend when it has no reservations", async () => {
    await saveJob(db, {
      ...job,
      status: "failed",
      refusal: "job-failed",
      spentUsdMicros: 7000,
      finishedAt: "2026-10-01T00:05:00.000Z",
    });
    expect(await month()).toBe(7000);
    expect(await day()).toBe(7000);
  });
});
