import type { Job } from "@repowiki/hosted";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import { generatedProject, testDeps } from "../routes/test-app.ts";
import { generationById, latestRevision } from "../store/drafts.ts";
import { jobById } from "../store/jobs.ts";
import { projectById } from "../store/projects.ts";
import { type ProjectView, projectPage } from "./project.ts";

let deps: Deps;
let view: ProjectView;
let job: Job;

beforeAll(async () => {
  deps = await testDeps();
  const p = await generatedProject(deps);
  const project = await projectById(deps.db, p.projectId);
  const revision = await latestRevision(deps.db, p.projectId);
  const done = await jobById(deps.db, p.jobId);
  if (project === null || revision === null || done === null) throw new Error("setup");
  job = done;
  view = {
    project,
    publicUrl: "http://127.0.0.1:8787/demo-dev/demo-repo",
    repoFullName: "demo-dev/demo-repo",
    job,
    revision,
    generation: await generationById(deps.db, revision.generationId),
    review: null,
    preview: null,
    current: null,
    titles: new Map(),
    session: { csrf: "c", login: "demo-dev" },
  };
});
afterAll(async () => deps.db.close());

const REFRESH = 'http-equiv="refresh"';

describe("the project page's reloads (fresh review I4)", () => {
  it("reloads itself while the first generation runs", () => {
    const running = { ...job, status: "running" } as Job;
    const first = projectPage({ ...view, job: running, revision: null, generation: null });
    expect(first).toContain(REFRESH);
  });

  it("never reloads over the editor while a refresh runs, and says how to see progress", () => {
    const running = { ...job, kind: "refresh", status: "running" } as Job;
    const body = projectPage({ ...view, job: running });
    expect(body).not.toContain(REFRESH);
    expect(body).toContain("Refreshing");
    expect(body).toContain(`href="/projects/${view.project.id}"`);
  });
});
