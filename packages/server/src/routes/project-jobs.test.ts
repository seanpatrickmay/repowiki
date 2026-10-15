import { REFUSALS } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { recordingRunner, type StartRequest } from "../runner/runner.ts";
import { jobById, tokenJob } from "../store/jobs.ts";
import { draftRoutes } from "./drafts.ts";
import { internalRoutes } from "./internal.ts";
import { jobRoutes } from "./project-jobs.ts";
import { projectRoutes } from "./projects.ts";
import {
  auditOutcomes,
  call,
  form,
  generatedProject,
  otherCookie,
  signedInCookie,
  startedJob,
  testDeps,
} from "./test-app.ts";

let deps: Deps;
let app: App;
let started: StartRequest[];
let job: { jobId: string; token: string; projectId: string };
let me: { cookie: string; csrf: string };

const post = (path: string, who = me) =>
  call(app, {
    method: "POST",
    path,
    headers: form(who.cookie, deps.config.origin),
    body: `csrf=${who.csrf}`,
  });
const worker = (path: string, body?: unknown) =>
  call(app, {
    method: "POST",
    path: `/internal/job/${path}`,
    headers: { authorization: `Bearer ${job.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const theJob = () => jobById(deps.db, job.jobId);

beforeEach(async () => {
  const recording = recordingRunner();
  started = recording.started;
  deps = await testDeps({ runner: recording.runner });
  app = createApp(deps, [
    ...internalRoutes(deps),
    ...jobRoutes(deps),
    ...draftRoutes(deps),
    ...projectRoutes(deps),
  ]);
  job = await startedJob(deps);
  me = await signedInCookie(deps);
  await worker("lease");
});
afterEach(async () => deps.db.close());

describe("cancel (Contract §6.1)", () => {
  it("cancels the owner's running job, charges its open spend and revokes its token", async () => {
    await deps.db.query(
      "INSERT INTO reservations (id, job_id, attempt, usd_micros) VALUES ($1, $2, 1, 4321)",
      [deps.newId(), job.jobId],
    );
    expect((await post(`/projects/${job.projectId}/jobs/${job.jobId}/cancel`)).status).toBe(303);
    expect(await theJob()).toMatchObject({ status: "cancelled", spentUsdMicros: 4321 });
    expect(await tokenJob(deps.db, job.token)).toBeNull();
  });

  it("is a 404 for another account, and for a job of another project", async () => {
    const other = await otherCookie(deps);
    const path = `/projects/${job.projectId}/jobs/${job.jobId}/cancel`;
    expect((await post(path, other)).status).toBe(404);
    const wrong = `/projects/00000000-0000-4000-8000-00000000ffff/jobs/${job.jobId}/cancel`;
    expect((await post(wrong)).status).toBe(404);
    expect((await post(`/projects/${job.projectId}/jobs/not-a-uuid/cancel`)).status).toBe(404);
    expect(await theJob()).toMatchObject({ status: "running" });
  });
});

describe("cancel refusals (spec 2 S5)", () => {
  it("audits a refused cancel in its own transaction", async () => {
    const path = `/projects/${job.projectId}/jobs/${job.jobId}/cancel`;
    expect((await post(path)).status).toBe(303);
    const again = await post(path);
    expect(again.status).toBe(REFUSALS["invalid-transition"].status);
    expect(await auditOutcomes(deps.db, "job.cancel", job.projectId)).toEqual([
      "allowed",
      "invalid-transition",
    ]);
  });
});

describe("retry (M14e A2)", () => {
  it("starts attempt 2 of a retryable failure with the same cap and a new token", async () => {
    await worker("fail", { code: "job-failed" });
    const before = await theJob();
    const page = await call(app, {
      path: `/projects/${job.projectId}`,
      headers: { cookie: me.cookie },
    });
    expect(String(page.body)).toContain(`/jobs/${job.jobId}/retry`);
    expect((await post(`/projects/${job.projectId}/jobs/${job.jobId}/retry`)).status).toBe(303);
    expect(await theJob()).toMatchObject({
      status: "queued",
      attempt: 2,
      capUsdMicros: before?.capUsdMicros,
    });
    const start = started.at(-1);
    expect(start).toMatchObject({ jobId: job.jobId, attempt: 2 });
    expect(await tokenJob(deps.db, start?.token ?? "")).toMatchObject({ attempt: 2 });
    expect(await tokenJob(deps.db, job.token)).toBeNull();
  });

  it("refuses to retry a job that hit its cost cap, and offers Start over instead", async () => {
    await worker("fail", { code: "job-cost-cap" });
    const reply = await post(`/projects/${job.projectId}/jobs/${job.jobId}/retry`);
    expect(reply.status).toBe(REFUSALS["invalid-transition"].status);
    expect(await theJob()).toMatchObject({ status: "failed", attempt: 1 });
    const page = await call(app, {
      path: `/projects/${job.projectId}`,
      headers: { cookie: me.cookie },
    });
    expect(String(page.body)).toContain("Start over");
    expect(String(page.body)).not.toContain("/retry");
  });

  it("is a 404 for another account", async () => {
    await worker("fail", { code: "job-failed" });
    const other = await otherCookie(deps);
    expect((await post(`/projects/${job.projectId}/jobs/${job.jobId}/retry`, other)).status).toBe(
      404,
    );
    expect(await theJob()).toMatchObject({ status: "failed" });
  });
});

describe("refresh (M14e A2)", () => {
  it("is refused on Free", async () => {
    const fresh = await testDeps();
    const p = await generatedProject(fresh);
    const freshApp = createApp(fresh, projectRoutes(fresh));
    const reply = await call(freshApp, {
      method: "POST",
      path: `/projects/${p.projectId}/refresh`,
      headers: form(p.cookie, fresh.config.origin),
      body: `csrf=${p.csrf}`,
    });
    expect(reply.status).toBe(REFUSALS["plan-refresh-limit"].status);
    const other = await otherCookie(fresh);
    const theirs = await call(freshApp, {
      method: "POST",
      path: `/projects/${p.projectId}/refresh`,
      headers: form(other.cookie, fresh.config.origin),
      body: `csrf=${other.csrf}`,
    });
    expect(theirs.status).toBe(404);
    await fresh.db.close();
  });
});
