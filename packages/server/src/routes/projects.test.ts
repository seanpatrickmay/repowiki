import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { FAKE_HEAD, FAKE_REPO } from "../github/fake.ts";
import type { App } from "../http/server.ts";
import { recordingRunner, type StartRequest } from "../runner/runner.ts";
import { saveGitHubToken } from "../store/github-tokens.ts";
import { jobById, tokenJob } from "../store/jobs.ts";
import { projectRoutes } from "./projects.ts";
import { call, form, signedInCookie, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let started: StartRequest[];

beforeEach(async () => {
  const recording = recordingRunner();
  started = recording.started;
  deps = await testDeps({ runner: recording.runner });
  app = createApp(deps, projectRoutes(deps));
});
afterEach(async () => deps.db.close());

const build = (cookie: string, body: string) =>
  call(app, {
    method: "POST",
    path: "/projects",
    headers: form(cookie, deps.config.origin),
    body,
  });

describe("the dashboard (spec 2 §7)", () => {
  it("sends a signed-out visitor to sign in", async () => {
    const reply = await call(app, { path: "/dashboard" });
    expect(reply.status).toBe(303);
    expect(reply.headers?.location).toBe("/auth/github");
  });

  it("lists the user's public repositories with a build button", async () => {
    const { cookie } = await signedInCookie(deps);
    const reply = await call(app, { path: "/dashboard", headers: { cookie } });
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain(FAKE_REPO.full_name);
    expect(String(reply.body)).toContain(`name="githubRepoId" value="${FAKE_REPO.id}"`);
    expect(String(reply.body)).not.toContain("style=");
  });

  it("lists the user's projects once one is started", async () => {
    const { cookie, csrf } = await signedInCookie(deps);
    const started = await build(cookie, `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`);
    const reply = await call(app, { path: "/dashboard", headers: { cookie } });
    expect(String(reply.body)).toContain(`href="${started.headers?.location}"`);
  });
});

describe("POST /projects (spec 2 §7)", () => {
  it("starts a generation of the head commit, issues a job token and starts the runner", async () => {
    const { cookie, csrf } = await signedInCookie(deps);
    const reply = await build(cookie, `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`);
    expect(reply.status).toBe(303);
    expect(String(reply.headers?.location)).toMatch(/^\/projects\/[0-9a-f-]{36}$/);
    expect(started).toHaveLength(1);
    expect(await tokenJob(deps.db, started[0]?.token ?? "")).toMatchObject({ attempt: 1 });
    expect(await jobById(deps.db, started[0]?.jobId ?? "")).toMatchObject({
      commitSha: FAKE_HEAD,
    });
  });

  it("does not start a second runner for a second click", async () => {
    const { cookie, csrf } = await signedInCookie(deps);
    const first = await build(cookie, `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`);
    const second = await build(cookie, `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`);
    expect(second.headers?.location).toBe(first.headers?.location);
    expect(started).toHaveLength(1);
  });

  it("shows the Contract's refusal for a repository GitHub does not show the user", async () => {
    const { cookie, csrf } = await signedInCookie(deps);
    const reply = await build(cookie, `csrf=${csrf}&githubRepoId=1`);
    expect(reply.status).toBe(403);
    expect(String(reply.body)).toContain("Only public repositories can have a project page.");
    expect(started).toEqual([]);
  });

  it("refuses an empty repository as invalid input, not a 500 (A6)", async () => {
    const github = deps.fetch;
    const empty: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/commits/main")) {
        return Response.json({ message: "Git Repository is empty." }, { status: 409 });
      }
      return github(input, init);
    };
    deps = { ...deps, fetch: empty };
    app = createApp(deps, projectRoutes(deps));
    const { cookie, csrf } = await signedInCookie(deps);
    const reply = await build(cookie, `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`);
    expect(reply.status).toBe(400);
    expect(String(reply.body)).toContain("The repository has no commits on its default branch.");
    expect(started).toEqual([]);
  });

  it("shows a revoked GitHub token as its refusal", async () => {
    const { cookie, csrf, accountId } = await signedInCookie(deps);
    await deps.db.transaction((tx) =>
      saveGitHubToken(tx, deps.config.tokenKey, accountId, "revoked-token"),
    );
    const reply = await build(cookie, `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`);
    expect(reply.status).toBe(401);
    expect(String(reply.body)).toContain("GitHub access was revoked.");
  });

  it("still sends the author to the project when the runner fails to start", async () => {
    deps = {
      ...deps,
      runner: {
        start: async () => {
          throw new Error("no machine");
        },
      },
    };
    app = createApp(deps, projectRoutes(deps));
    const { cookie, csrf } = await signedInCookie(deps);
    const reply = await build(cookie, `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`);
    expect(reply.status).toBe(303);
  });

  it("logs a failing start by its error's name only", async () => {
    const lines: object[] = [];
    deps = {
      ...deps,
      log: (line) => lines.push(line),
      runner: {
        start: async () => {
          throw new RangeError("secret detail sk-live");
        },
      },
    };
    app = createApp(deps, projectRoutes(deps));
    const { cookie, csrf } = await signedInCookie(deps);
    await build(cookie, `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`);
    expect(lines).toEqual([
      { runner: "start-failed", job: expect.any(String), error: "RangeError" },
    ]);
  });

  it("refuses a missing CSRF token and a bad repository id", async () => {
    const { cookie, csrf } = await signedInCookie(deps);
    expect((await build(cookie, `githubRepoId=${FAKE_REPO.id}`)).status).toBe(403);
    expect((await build(cookie, `csrf=${csrf}&githubRepoId=x`)).status).toBe(400);
  });
});
