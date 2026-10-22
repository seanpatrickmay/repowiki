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
    previewBuild: null,
    current: null,
    plan: "free",
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

describe("the project page's content (ADR-0013)", () => {
  it("shows the contribution the biography will quote, labelled, and nothing else generated", () => {
    const body = projectPage(view);
    expect(body).toContain("I wrote the ingest code.");
    expect(body).toContain("not by you.");
    expect(body).toContain("your entry");
    for (const gone of ["Tagline", "Summary", "Highlights"]) expect(body).not.toContain(gone);
  });
});

describe("the project page's words (the persona review)", () => {
  it("speaks a student's words, not the pipeline's", () => {
    const body = projectPage(view);
    for (const internal of ["Generation:", "manifest", "cluster", "State: draft", "biography"]) {
      expect(body, internal).not.toContain(internal);
    }
    expect(body).toContain("Building your entry: done");
    expect(body).toContain("Not published yet");
    expect(body).toContain("Checking the citations");
  });

  it("says what the preview is for, and how to correct a wrong sentence, beside the buttons", () => {
    const body = projectPage(view);
    expect(body).toContain("The preview shows your pages exactly as readers will see them");
    expect(body).toContain(`href="/projects/${view.project.id}/corrections"`);
  });

  it("names the preview and publish buttons by what they do", () => {
    const n = view.revision?.number ?? 0;
    const preview = { projectId: view.project.id, revision: n, siteHash: "a".repeat(64) };
    const body = projectPage({ ...view, preview } as ProjectView);
    expect(body).toContain("Build a new preview</button>");
    expect(body).toContain("Open the preview</button>");
    expect(body).toContain("Publish what the preview shows</button>");
    expect(body).toContain("Anyone with the link can see it in that hour.");
  });
});

describe("the project page's rebuild (marketing review)", () => {
  it("offers Free its one rebuild before publishing, and says what it is", () => {
    const body = projectPage({ ...view, project: { ...view.project, latestRevision: 1 } });
    expect(body).toContain(`action="/projects/${view.project.id}/refresh"`);
    expect(body).toContain("one rebuild before you publish");
  });

  it("still offers Free its rebuild after a correction added a revision (ADR-0023)", () => {
    const corrected = { ...view.project, latestRevision: 2 };
    expect(projectPage({ ...view, project: corrected })).not.toContain("/refresh");
    expect(projectPage({ ...view, project: corrected, corrections: 1 })).toContain(
      "one rebuild before you publish",
    );
  });

  it("offers Free nothing once its project is published, and Pro a refresh", () => {
    const published = { ...view.project, latestRevision: 1, currentVersion: 1 };
    expect(projectPage({ ...view, project: published })).not.toContain("/refresh");
    expect(projectPage({ ...view, project: published, plan: "pro" })).toContain(
      "Refresh from the latest commit",
    );
  });
});

describe("the project page during and after a correction (ADR-0023)", () => {
  const correcting = (patch: Partial<Job>) => ({ ...job, kind: "correct", ...patch }) as Job;

  it("names a running correction and its two steps, and offers no correction meanwhile", () => {
    const body = projectPage({ ...view, job: correcting({ status: "running", step: "write" }) });
    expect(body).toContain("Correcting sentences: in progress");
    expect(body).toContain("Rewriting the sentences from the code");
    expect(body).not.toContain("Grouping the files into features");
    expect(body).not.toContain(`href="/projects/${view.project.id}/corrections"`);
  });

  it("says what a finished correction changed", () => {
    const outcomes = [
      { page: "signals", claimId: "c1", outcome: "rewritten" as const },
      { page: "signals", claimId: "c2", outcome: "rewritten" as const },
      { page: "signals", claimId: "c3", outcome: "removed" as const },
    ];
    const body = projectPage({ ...view, job: correcting({ status: "succeeded" }), outcomes });
    expect(body).toContain("2 sentences rewritten from the code and 1 removed");
  });
});
