import type { Account, EligibilityFacts, Project } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import type { GitHubRepo } from "../github/api.ts";
import { FAKE_REPO, FAKE_USER } from "../github/fake.ts";
import { signIn } from "./accounts.ts";
import { jobSpec } from "./jobs.ts";
import { projectFor, usageFor } from "./projects.ts";
import { estimateFor, type StartInput, startGeneration, startRefresh } from "./start.ts";
import { freshDb } from "./test-db.ts";

const NOW = "2026-10-14T12:00:00.000Z";
const SHA = "c".repeat(40);
let db: Db;
let account: Account;
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const facts = (patch: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  checkedAt: NOW,
  githubUserId: FAKE_USER.id,
  githubRepoId: FAKE_REPO.id,
  fullName: FAKE_REPO.full_name,
  visibility: "public",
  isFork: false,
  permission: "admin",
  authoredCommits: 42,
  indexedFiles: null,
  tokenValid: true,
  ...patch,
});
const input = (patch: Partial<StartInput> = {}): StartInput => ({
  account,
  facts: facts(),
  repo: FAKE_REPO as GitHubRepo,
  commitSha: SHA,
  commitShas: ["1".repeat(40)],
  now: NOW,
  newId,
  ...patch,
});

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
    { newAccountId: newId(), allowNew: () => true, now: NOW },
  );
  account = signed?.account as Account;
});
afterEach(async () => db.close());

describe("startGeneration (spec 2 §7, Contract §6.1, §7.1)", () => {
  it("creates the project, its first job and the worker's spec", async () => {
    const started = await startGeneration(db, input());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.created).toBe(true);
    expect(started.value.project).toMatchObject({
      slug: "demo-repo",
      state: "draft",
      githubRepoId: FAKE_REPO.id,
    });
    expect(started.value.job).toMatchObject({
      kind: "generate",
      status: "queued",
      commitSha: SHA,
      estimateUsdMicros: estimateFor("free"),
      capUsdMicros: 1_000_000,
    });
    expect(await jobSpec(db, started.value.job.id)).toMatchObject({
      repo: { fullName: FAKE_REPO.full_name, cloneUrl: FAKE_REPO.clone_url },
      author: { login: FAKE_USER.login, commitShas: ["1".repeat(40)] },
      plan: "free",
      export: null,
    });
    const audit = await db.query<{ body: { action: string; outcome: string } }>(
      "SELECT body FROM audit_events WHERE body->>'action' <> 'account.create'",
    );
    expect(audit.map((a) => [a.body.action, a.body.outcome])).toEqual([["job.create", "allowed"]]);
  });

  it("returns the running job for a second click instead of a second project", async () => {
    const first = await startGeneration(db, input());
    const second = await startGeneration(db, input());
    expect(second).toMatchObject({ ok: true, value: { created: false } });
    if (first.ok && second.ok) expect(second.value.job.id).toBe(first.value.job.id);
    expect(await db.query("SELECT * FROM projects")).toHaveLength(1);
    expect(await db.query("SELECT * FROM jobs")).toHaveLength(1);
  });

  it("refuses an ineligible repository and audits the refusal", async () => {
    const refused = await startGeneration(db, input({ facts: facts({ isFork: true }) }));
    expect(refused).toEqual({ ok: false, code: "repo-fork" });
    expect(await db.query("SELECT * FROM projects")).toEqual([]);
    const audit = await db.query<{ body: { outcome: string } }>(
      "SELECT body FROM audit_events WHERE body->>'action' = 'job.create'",
    );
    expect(audit.map((a) => a.body.outcome)).toEqual(["repo-fork"]);
  });

  it("refuses a second project on Free", async () => {
    await startGeneration(db, input());
    const other = {
      ...FAKE_REPO,
      id: 777,
      name: "other",
      full_name: "demo-dev/other",
    } as GitHubRepo;
    const refused = await startGeneration(
      db,
      input({ repo: other, facts: facts({ githubRepoId: 777 }) }),
    );
    expect(refused).toMatchObject({ ok: false, code: "plan-project-limit" });
  });

  it("counts the reserved cap and the job in flight in usage", async () => {
    await startGeneration(db, input());
    expect(await usageFor(db, account.id, NOW)).toEqual({
      activeProjects: 1,
      generationsLifetime: 0,
      generationsThisMonth: 0,
      refreshesThisMonth: 0,
      inFlightGenerations: 1,
      inFlightRefreshes: 0,
      monthUsdMicros: 1_000_000,
      platformDayUsdMicros: 1_000_000,
    });
  });

  it("refuses a refresh on Free", async () => {
    await startGeneration(db, input());
    const project = (await projectFor(db, account.id, FAKE_REPO.id)) as Project;
    expect(await startRefresh(db, { ...input(), project })).toMatchObject({ ok: false });
  });
});
