import type { Account, EligibilityFacts, Project } from "@repowiki/hosted";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { GitHubRepo } from "../github/api.ts";
import { FAKE_REPO, FAKE_USER } from "../github/fake.ts";
import type { App } from "../http/server.ts";
import { accountById } from "../store/accounts.ts";
import { generationsOf, latestRevision } from "../store/drafts.ts";
import { jobById, jobSpec } from "../store/jobs.ts";
import { projectById } from "../store/projects.ts";
import { estimateFor, startCorrection } from "../store/start.ts";
import { internalRoutes } from "./internal.ts";
import { call, generatedProject, startedJob, testDeps } from "./test-app.ts";

// Each test builds a project through the internal API on PGlite: seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NOTE = "This is wrong: the cap is per chunk, not per run.";
let deps: Deps;
let app: App;
let project: Project;
let account: Account;
beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, internalRoutes(deps));
  const { projectId, accountId } = await generatedProject(deps);
  project = (await projectById(deps.db, projectId)) as Project;
  account = (await accountById(deps.db, accountId)) as Account;
});
afterEach(async () => deps.db.close());

const facts = (): EligibilityFacts => ({
  checkedAt: deps.now(),
  githubUserId: FAKE_USER.id,
  githubRepoId: FAKE_REPO.id,
  fullName: FAKE_REPO.full_name,
  visibility: "public",
  isFork: false,
  permission: "admin",
  authoredCommits: 2,
  indexedFiles: null,
  tokenValid: true,
});
const [first] = fixtureExport().pages;
const items = [{ page: first?.featureId ?? "", claimId: "c1", note: NOTE }];

/** A correction of the project's latest generation, started through the store; its token. */
async function corrected(): Promise<{ jobId: string; token: string }> {
  const [generation] = await generationsOf(deps.db, project.id);
  if (generation === undefined) throw new Error("no generation");
  const started = await startCorrection(deps.db, {
    account,
    facts: facts(),
    repo: FAKE_REPO as GitHubRepo,
    commitSha: generation.commitSha,
    commitShas: [],
    now: deps.now(),
    newId: deps.newId,
    project,
    correction: { generationId: generation.id, items },
  });
  if (!started.ok || started.value.token === null) throw new Error("correction refused");
  return { jobId: started.value.job.id, token: started.value.token };
}
const worker = (token: string) => {
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, "content-type": "application/json" };
  return {
    lease: () => call(app, { method: "POST", path: "/internal/job/lease", headers: auth }),
    source: () => call(app, { method: "GET", path: "/internal/job/source-export", headers: auth }),
    upload: () =>
      call(app, {
        method: "PUT",
        path: "/internal/job/export",
        headers: json,
        body: JSON.stringify(fixtureExport()),
      }),
    succeed: (body: unknown) =>
      call(app, {
        method: "POST",
        path: "/internal/job/succeed",
        headers: json,
        body: JSON.stringify(body),
      }),
    fail: () =>
      call(app, {
        method: "POST",
        path: "/internal/job/fail",
        headers: json,
        body: JSON.stringify({ code: "correction-unchanged" }),
      }),
  };
};
const outcomes = [{ page: items[0]?.page, claimId: "c1", outcome: "rewritten", detail: null }];

describe("a correction job (sentence corrections spec)", () => {
  it("starts at the generation's commit, for a tenth of a build's estimate", async () => {
    const { jobId } = await corrected();
    const job = await jobById(deps.db, jobId);
    const [generation] = await generationsOf(deps.db, project.id);
    expect(job).toMatchObject({ kind: "correct", commitSha: generation?.commitSha });
    expect(job?.estimateUsdMicros).toBe(Math.ceil(estimateFor(account.plan) / 10));
  });

  it("leases with the items and serves the export it corrects", async () => {
    const w = worker((await corrected()).token);
    const lease = await w.lease();
    expect(JSON.parse(String(lease.body))).toMatchObject({
      kind: "correct",
      correction: { items },
    });
    const source = await w.source();
    expect(source.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(source.body as Uint8Array))).toEqual(
      JSON.parse(JSON.stringify(fixtureExport())),
    );
  });

  it("makes the next revision from the corrected export with its parent's facts, and forgets the notes", async () => {
    const { jobId, token } = await corrected();
    const w = worker(token);
    await w.lease();
    await w.upload();
    const done = await w.succeed({ engineVersion: "test", models: ["claude-haiku-5-5"], outcomes });
    expect(done.status).toBe(204);
    const [latest, parent] = await generationsOf(deps.db, project.id);
    expect(latest?.jobId).toBe(jobId);
    expect(latest?.facts).toEqual(parent?.facts);
    expect(latest?.suggestions).toEqual(parent?.suggestions);
    expect((await latestRevision(deps.db, project.id))?.number).toBe(2);
    expect((await jobSpec(deps.db, jobId))?.correction).toEqual({
      generationId: parent?.id,
      items: [{ ...items[0], note: null }],
      outcomes: [{ page: items[0]?.page, claimId: "c1", outcome: "rewritten" }],
    });
    const stored = await deps.db.query<{ t: string }>(
      "SELECT body::text AS t FROM job_specs UNION ALL SELECT body::text FROM audit_events",
    );
    for (const row of stored) expect(row.t).not.toContain(NOTE);
  });

  it("forgets the notes of a correction that changed nothing, and refuses a build's success", async () => {
    const { jobId, token } = await corrected();
    const w = worker(token);
    await w.lease();
    await w.upload();
    expect((await w.succeed({ engineVersion: "test", models: ["m"] })).status).toBe(400);
    expect((await w.fail()).status).toBe(204);
    expect(await jobById(deps.db, jobId)).toMatchObject({
      status: "failed",
      refusal: "correction-unchanged",
    });
    expect((await jobSpec(deps.db, jobId))?.correction?.items[0]?.note).toBeNull();
  });

  it("serves no source export to a build's worker", async () => {
    const fresh = await testDeps();
    try {
      const { token } = await startedJob(fresh);
      const auth = { authorization: `Bearer ${token}` };
      const own = createApp(fresh, internalRoutes(fresh));
      await call(own, { method: "POST", path: "/internal/job/lease", headers: auth });
      const reply = await call(own, {
        method: "GET",
        path: "/internal/job/source-export",
        headers: auth,
      });
      expect(reply.status).toBe(409);
    } finally {
      await fresh.db.close();
    }
  });
});
