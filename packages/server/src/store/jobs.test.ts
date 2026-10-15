import { createJob, type Job, leaseJob } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import {
  activeJob,
  issueToken,
  jobById,
  revokeTokens,
  saveJob,
  settleOpen,
  tokenJob,
  tokensIssued,
} from "./jobs.ts";
import { freshDb } from "./test-db.ts";

const NOW = "2026-10-14T12:00:00.000Z";
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
let db: Db;

function aJob(): Job {
  const created = createJob(
    {
      id: JOB_ID,
      projectId: PROJECT_ID,
      kind: "generate",
      commitSha: "c".repeat(40),
      estimateUsdMicros: 10_000,
      capUsdMicros: 15_000,
      now: NOW,
    },
    null,
  );
  if (!created.ok) throw new Error("job");
  return created.value.job;
}

function running(): Job {
  const leased = leaseJob(aJob(), NOW, 60_000);
  if (!leased.ok) throw new Error("lease");
  return leased.value;
}

const reserve = (usd: number, n: number) =>
  db.query("INSERT INTO reservations (id, job_id, attempt, usd_micros) VALUES ($1, $2, 1, $3)", [
    `00000000-0000-4000-8000-00000000010${n}`,
    JOB_ID,
    usd,
  ]);

beforeEach(async () => {
  db = await freshDb();
});
afterEach(async () => db.close());

describe("job tokens (spec 2 §6)", () => {
  it("are stored hashed, bound to a job and attempt, and revocable", async () => {
    const job = aJob();
    await saveJob(db, job);
    const token = await issueToken(db, job.id, job.attempt, NOW);
    expect(await tokenJob(db, token)).toMatchObject({ jobId: job.id, attempt: 1 });
    expect(await tokenJob(db, "forged")).toBeNull();
    expect(await tokensIssued(db, job.id, 1)).toMatchObject({ count: 1 });
    const rows = await db.query<{ token_hash: string }>("SELECT token_hash FROM job_tokens");
    expect(rows.map((r) => r.token_hash)).not.toContain(token);
    await revokeTokens(db, job.id);
    expect(await tokenJob(db, token)).toBeNull();
    expect((await activeJob(db, job.projectId))?.id).toBe(job.id);
    expect(await jobById(db, job.id)).toEqual(job);
  });
});

describe("settleOpen (spec 2 §6)", () => {
  it("charges every open reservation as spend and closes them", async () => {
    await saveJob(db, running());
    await reserve(1200, 1);
    await reserve(300, 2);
    const settled = await settleOpen(db, running(), "2026-10-14T12:00:00.000Z");
    expect(settled.spentUsdMicros).toBe(1500);
    expect(await db.query("SELECT * FROM reservations WHERE NOT settled")).toEqual([]);
  });

  it("never charges past the job's cap", async () => {
    await saveJob(db, running());
    await reserve(40_000, 1);
    expect((await settleOpen(db, running(), "2026-10-14T12:00:00.000Z")).spentUsdMicros).toBe(
      15_000,
    );
  });
});
