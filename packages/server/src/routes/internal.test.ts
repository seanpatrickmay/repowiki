import { type Job, recoverJob } from "@repowiki/hosted";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { FAKE_USER } from "../github/fake.ts";
import type { App } from "../http/server.ts";
import { generationById, latestRevision } from "../store/drafts.ts";
import { issueToken, jobById, jobSpec, revokeTokens, saveJob } from "../store/jobs.ts";
import { projectById } from "../store/projects.ts";
import { internalRoutes } from "./internal.ts";
import { call, startedJob, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let job: { jobId: string; token: string; projectId: string };
const bearer = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});
const post = (path: string, token: string, body?: unknown) =>
  call(app, {
    method: "POST",
    path,
    headers: bearer(token, body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const putExport = (token: string, body: string) =>
  call(app, {
    method: "PUT",
    path: "/internal/job/export",
    headers: bearer(token, { "content-type": "application/json" }),
    body,
  });

const suggestions = {
  tagline: "A tiny demo",
  summary: "It demonstrates RepoWiki.",
  contributionDraft: "I wrote it.",
  highlightCandidates: [],
};
const facts = () => ({
  languages: [{ name: "Python", share: 1 }],
  indexedFiles: 3,
  featureIds: fixtureExport().manifest.features.map((f) => f.id),
  author: { commits: 2, totalCommits: 2, currentLines: 10, totalLines: 10, features: [] },
});
const success = () => ({
  suggestions,
  facts: facts(),
  engineVersion: "0.0.0",
  models: ["claude-haiku-4-5"],
});

beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, internalRoutes(deps));
  job = await startedJob(deps);
});
afterEach(async () => deps.db.close());

describe("the worker's internal API (spec 2 §6)", () => {
  it("refuses a missing or forged token", async () => {
    expect((await call(app, { method: "POST", path: "/internal/job/lease" })).status).toBe(401);
    expect((await post("/internal/job/lease", "forged")).status).toBe(401);
  });

  it("checks the token before reading a body (A4)", async () => {
    const reply = await call(app, {
      method: "PUT",
      path: "/internal/job/export",
      headers: { "content-type": "application/json", "content-length": String(64 * 1024 * 1024) },
      body: "{}",
    });
    expect(reply.status).toBe(401);
  });

  it("leases the job once and returns the worker's spec, idempotently", async () => {
    const first = await post("/internal/job/lease", job.token);
    expect(first.status).toBe(200);
    expect(JSON.parse(String(first.body))).toMatchObject({
      jobId: job.jobId,
      attempt: 1,
      kind: "generate",
      repo: { fullName: "demo-dev/demo-repo", name: "demo-repo" },
      author: { login: "demo-dev" },
      limits: { maxIndexedFiles: 1000 },
      llmUrl: `${deps.config.runner.internalUrl}/llm`,
    });
    expect((await post("/internal/job/lease", job.token)).status).toBe(200);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ status: "running", step: "fetch" });
  });

  it("lets only the token that leased an attempt act on it (A5)", async () => {
    const second = await issueToken(deps.db, job.jobId, 1, deps.now());
    expect((await post("/internal/job/lease", job.token)).status).toBe(200);
    expect((await post("/internal/job/lease", second)).status).toBe(409);
    expect((await post("/internal/job/heartbeat", second, { step: "index" })).status).toBe(409);
    expect((await post("/internal/job/fail", second, { code: "job-failed" })).status).toBe(409);
    expect((await post("/internal/job/heartbeat", job.token, { step: "index" })).status).toBe(204);
  });

  it("records heartbeats and fails a repository over the plan's file limit", async () => {
    await post("/internal/job/lease", job.token);
    expect((await post("/internal/job/heartbeat", job.token, { step: "index" })).status).toBe(204);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ step: "index" });
    expect((await post("/internal/job/heartbeat", job.token, { step: "nope" })).status).toBe(400);
    const ok = await post("/internal/job/indexed", job.token, { indexedFiles: 1000 });
    expect(ok.status).toBe(204);
    const big = await post("/internal/job/indexed", job.token, { indexedFiles: 1001 });
    expect(big.status).toBe(422);
    expect(JSON.parse(String(big.body))).toEqual({ code: "repo-too-large" });
    expect(await jobById(deps.db, job.jobId)).toMatchObject({
      status: "failed",
      refusal: "repo-too-large",
    });
    expect((await post("/internal/job/heartbeat", job.token, { step: "write" })).status).toBe(401);
  });

  it("refuses a heartbeat before the lease", async () => {
    expect((await post("/internal/job/heartbeat", job.token, { step: "index" })).status).toBe(409);
  });

  it("stores the export, then creates the generation and revision 1 on success", async () => {
    await post("/internal/job/lease", job.token);
    expect((await putExport(job.token, JSON.stringify(fixtureExport()))).status).toBe(204);
    const key = `exports/${job.jobId}-1.json`;
    expect((await jobSpec(deps.db, job.jobId))?.export?.key).toBe(key);
    expect(await deps.objects.head(key)).not.toBeNull();
    expect((await post("/internal/job/succeed", job.token, success())).status).toBe(204);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ status: "succeeded" });
    const revision = await latestRevision(deps.db, job.projectId);
    // The revision holds the generated content (ADR-0012): the model's draft, as written.
    expect(revision).toMatchObject({
      number: 1,
      content: { tagline: "A tiny demo", contribution: "I wrote it.", highlights: [] },
    });
    expect(await generationById(deps.db, revision?.generationId ?? "")).toMatchObject({
      jobId: job.jobId,
      exportKey: key,
      suggestions,
    });
    expect(await projectById(deps.db, job.projectId)).toMatchObject({ latestRevision: 1 });
    expect((await post("/internal/job/heartbeat", job.token, { step: "render" })).status).toBe(401);
  });

  it("writes the contribution from the facts when the model wrote none (ADR-0012)", async () => {
    await post("/internal/job/lease", job.token);
    await putExport(job.token, JSON.stringify(fixtureExport()));
    const blank = { ...success(), suggestions: { ...suggestions, contributionDraft: "" } };
    expect((await post("/internal/job/succeed", job.token, blank)).status).toBe(204);
    expect((await latestRevision(deps.db, job.projectId))?.content.contribution).toBe(
      `${FAKE_USER.name} wrote 2 of the repository's 2 commits and about 100% of its current lines.`,
    );
  });

  it("refuses success before the export is stored, and an invalid export", async () => {
    await post("/internal/job/lease", job.token);
    const empty = { ...success(), facts: {} };
    expect((await post("/internal/job/succeed", job.token, empty)).status).toBe(400);
    expect((await post("/internal/job/succeed", job.token, success())).status).toBe(409);
    expect((await putExport(job.token, '{"schemaVersion":1}')).status).toBe(400);
    expect((await putExport(job.token, "{not json")).status).toBe(400);
  });

  it("fails a job with a worker code and refuses any other code", async () => {
    await post("/internal/job/lease", job.token);
    expect((await post("/internal/job/fail", job.token, { code: "frozen" })).status).toBe(400);
    expect((await post("/internal/job/fail", job.token, { code: "job-failed" })).status).toBe(204);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({
      status: "failed",
      refusal: "job-failed",
    });
  });

  it("charges an open reservation as spend when the job ends", async () => {
    await post("/internal/job/lease", job.token);
    await deps.db.query(
      "INSERT INTO reservations (id, job_id, attempt, usd_micros) VALUES ($1, $2, 1, 12345)",
      [deps.newId(), job.jobId],
    );
    await post("/internal/job/fail", job.token, { code: "job-failed" });
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ spentUsdMicros: 12345 });
  });

  it("refuses success on an earlier attempt's export", async () => {
    await post("/internal/job/lease", job.token);
    expect((await putExport(job.token, JSON.stringify(fixtureExport()))).status).toBe(204);
    // The lease runs out and the sweeper moves the job to attempt 2 with a new token.
    const running = (await jobById(deps.db, job.jobId)) as Job;
    const recovered = recoverJob(running, "2026-10-14T13:00:00.000Z");
    if (!recovered.ok) throw new Error(recovered.code);
    await saveJob(deps.db, recovered.value);
    await revokeTokens(deps.db, job.jobId);
    const second = await issueToken(deps.db, job.jobId, 2, deps.now());
    expect((await post("/internal/job/lease", second)).status).toBe(200);
    expect((await post("/internal/job/succeed", second, success())).status).toBe(409);
    expect(await jobById(deps.db, job.jobId)).toMatchObject({ status: "running", attempt: 2 });
  });
});
