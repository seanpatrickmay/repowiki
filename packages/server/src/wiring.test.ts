import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";
import { githubApi } from "./github/api.ts";
import { GITHUB } from "./github/endpoints.ts";
import { FAKE_TOKEN } from "./github/fake.ts";
import { adaProfile, writeProfile } from "./github/test-profile.ts";
import { call, freePort } from "./routes/test-app.ts";
import { freshDb } from "./store/test-db.ts";
import {
  buildDeps,
  listenersFor,
  routeSets,
  startServer,
  startupFailure,
  workerMode,
} from "./wiring.ts";

const DEMO = { REPOWIKI_MODE: "demo" };
const PRODUCTION = {
  REPOWIKI_MODE: "production",
  APP_ORIGIN: "https://app.repowiki.dev",
  PUBLIC_ORIGIN: "https://repowiki.dev",
  DATABASE_URL: "postgres://u:p@db.example/repowiki",
  TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
  GITHUB_CLIENT_ID: "Iv1.abc",
  GITHUB_CLIENT_SECRET: "s3cret",
  ANTHROPIC_API_KEY: "sk-ant-x",
  R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  R2_BUCKET: "repowiki",
  R2_ACCESS_KEY_ID: "id",
  R2_SECRET_ACCESS_KEY: "secret",
  FLY_API_TOKEN: "fly",
  FLY_WORKER_APP: "repowiki-workers",
  WORKER_IMAGE: "registry.fly.io/repowiki-workers:1",
  INTERNAL_URL: "http://repowiki.internal:8788",
  REPOWIKI_ENGINE_VERSION: "abc1234",
};

const dataDir = () => mkdtempSync(join(tmpdir(), "repowiki-wiring-"));
const top = (routes: { pattern: string }[]) => new Set(routes.map((r) => r.pattern.split("/")[1]));

describe("route sets (spec 2 S1)", () => {
  it("keeps the worker's routes off both hosts' sets, and handles on the pages set only", async () => {
    const deps = await buildDeps(loadConfig(DEMO));
    const sets = routeSets(deps);
    for (const set of [sets.app, sets.pages]) {
      expect(top(set).has("internal")).toBe(false);
      expect(top(set).has("llm")).toBe(false);
    }
    expect([...top(sets.worker)].sort()).toEqual(["internal", "llm"]);
    expect(sets.app[0]?.pattern).toBe("/");
    expect(sets.app.some((r) => r.pattern.startsWith("/:handle"))).toBe(false);
    expect(top(sets.pages).has("dashboard")).toBe(false);
    expect(top(sets.pages).has("auth")).toBe(false);
    expect(sets.pages.slice(-2).map((r) => r.pattern)).toEqual(["/:handle/:slug/*", "/:handle/*"]);
    // The example's paths come before any handle's (ADR-0017).
    const at = (pattern: string) => sets.pages.findIndex((r) => r.pattern === pattern);
    expect(at("/example/:slug/*")).toBeGreaterThan(-1);
    expect(at("/example/:slug/*")).toBeLessThan(at("/:handle/:slug/*"));
    await deps.db.close();
  });

  it("wires the demo with fakes for GitHub, the model and the worker", async () => {
    const deps = await buildDeps(loadConfig(DEMO));
    expect(deps.config.github.kind).toBe("fake");
    expect(deps.github.web).toBe(`${deps.config.appOrigin}/_fake/github`);
    expect(deps.anthropic).toMatchObject({ url: "https://api.anthropic.test", key: "demo" });
    expect(workerMode(deps.config)).toBe("fixture");
    await deps.db.close();
  });

  it("serves a local profile's user from the fake GitHub", async () => {
    const config = loadConfig({
      REPOWIKI_MODE: "development",
      DATA_DIR: dataDir(),
      REPOWIKI_PROFILE: writeProfile(adaProfile()),
    });
    const deps = await buildDeps(config, { db: await freshDb() });
    expect(await githubApi(deps.fetch, deps.github).user(FAKE_TOKEN)).toMatchObject({
      login: "ada",
    });
    expect(workerMode(config)).toBe("import");
    await deps.db.close();
  });

  it("runs the engine locally only with real GitHub and a model key", () => {
    const dev = { REPOWIKI_MODE: "development", DATA_DIR: dataDir() };
    const oauth = { GITHUB_CLIENT_ID: "Iv1.dev", GITHUB_CLIENT_SECRET: "dev" };
    expect(workerMode(loadConfig(dev))).toBe("fixture");
    expect(workerMode(loadConfig({ ...dev, ...oauth }))).toBe("fixture");
    expect(workerMode(loadConfig({ ...dev, ANTHROPIC_API_KEY: "sk-ant-x" }))).toBe("fixture");
    expect(workerMode(loadConfig({ ...dev, ...oauth, ANTHROPIC_API_KEY: "sk-ant-x" }))).toBe(
      "engine",
    );
  });
});

describe("listeners (spec 2 S1)", () => {
  it("serves workers on a second port in production, and hides their routes from the public one", async () => {
    const deps = await buildDeps(loadConfig(PRODUCTION), { db: await freshDb() });
    expect(deps.github).toEqual(GITHUB);
    expect(deps.anthropic).toMatchObject({ url: "https://api.anthropic.com", key: "sk-ant-x" });
    const [pub, worker, ...rest] = listenersFor(deps);
    expect(rest).toEqual([]);
    expect(pub).toMatchObject({ port: 8787, host: "0.0.0.0" });
    expect(worker).toMatchObject({ port: 8788, host: "::" });
    if (pub === undefined || worker === undefined) throw new Error("listeners");
    for (const host of ["app.repowiki.dev", "repowiki.dev"]) {
      for (const path of ["/internal/job/lease", "/llm/v1/messages", "/internal", "/llm"]) {
        const headers = { host };
        expect((await call(pub.app, { method: "POST", path, headers })).status, path).toBe(404);
        expect((await call(pub.app, { path: `${path}/x`, headers })).status, path).toBe(404);
      }
    }
    expect((await call(pub.app, { path: "/", headers: { host: "app.repowiki.dev" } })).status).toBe(
      302,
    );
    expect((await call(pub.app, { path: "/", headers: { host: "repowiki.dev" } })).status).toBe(
      200,
    );
    // No host is a 404; Fly's health check uses /healthz, which answers on any host.
    expect((await call(pub.app, { path: "/" })).status).toBe(404);
    expect((await call(worker.app, { method: "POST", path: "/internal/job/lease" })).status).toBe(
      401,
    );
    expect((await call(worker.app, { path: "/" })).status).toBe(404);
    expect((await call(worker.app, { path: "/dashboard" })).status).toBe(404);
    await deps.db.close();
  });

  it("runs one loopback listener outside production, worker routes before handles", async () => {
    const deps = await buildDeps(loadConfig(DEMO));
    const [only, ...rest] = listenersFor(deps);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ port: 8787, host: "127.0.0.1" });
    if (only === undefined) throw new Error("listener");
    const app = { host: "127.0.0.1:8787" };
    const pages = { host: "localhost:8787" };
    const status = async (path: string, headers: Record<string, string>, method?: "POST") =>
      (await call(only.app, { path, headers, ...(method ? { method } : {}) })).status;
    expect(await status("/internal/job/lease", app, "POST")).toBe(401);
    // The pages host is read-only: no worker route, and no method but GET.
    expect(await status("/internal/job/lease", pages, "POST")).toBe(405);
    expect(await status("/", app)).toBe(302);
    expect(await status("/dashboard", app)).toBe(303);
    expect(await status("/dashboard", pages)).toBe(404);
    expect(await status("/auth/github", pages)).toBe(404);
    expect(await status("/_app/biography.css", pages)).toBe(200);
    expect(await status("/_app/style.css", pages)).toBe(404);
    const root = await call(only.app, { path: "/", headers: pages });
    expect(root.status).toBe(200);
    expect(String(root.body)).toContain("Show recruiters what you actually built.");
    // A handle is a pages path; on the app host it is no page at all.
    const handle = await call(only.app, { path: "/nobody", headers: app });
    expect(String(handle.body)).toContain("is not a page on RepoWiki");
    expect(String((await call(only.app, { path: "/nobody", headers: pages })).body)).toBe(
      "Not found",
    );
    await deps.db.close();
  });
});

describe("startServer", () => {
  it("answers the landing page over HTTP and closes cleanly", async () => {
    const port = await freePort();
    const server = await startServer(loadConfig({ ...DEMO, PORT: String(port) }));
    expect(server.urls).toEqual([`http://127.0.0.1:${port}`]);
    const reply = await fetch(`http://127.0.0.1:${port}/`);
    expect(reply.status).toBe(200);
    await reply.text();
    await server.close();
  }, 60_000);

  it("rejects with the bind error when its port is taken", async () => {
    const port = await freePort();
    const first = await startServer(loadConfig({ ...DEMO, PORT: String(port) }));
    try {
      const second = startServer(loadConfig({ ...DEMO, PORT: String(port) }));
      await expect(second).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  }, 60_000);
});

describe("startupFailure (spec 2 S17)", () => {
  it("names the error and its system code, never its message", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED postgres://u:secret@db"), {
      code: "ECONNREFUSED",
    });
    expect(startupFailure(refused)).toBe("The server failed to start (Error, ECONNREFUSED).");
    const taken = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    expect(startupFailure(taken)).toBe("The server failed to start (Error, EADDRINUSE).");
    expect(startupFailure(new TypeError("token sk-ant-x"))).toBe(
      "The server failed to start (TypeError).",
    );
    // A code that is not a plain identifier could carry anything, so it is left out.
    const odd = Object.assign(new Error("x"), { code: "password=hunter2 " });
    expect(startupFailure(odd)).toBe("The server failed to start (Error).");
    expect(startupFailure("boom")).toBe("The server failed to start (unknown).");
    expect(startupFailure(new ConfigError("PORT is invalid."))).toBe("PORT is invalid.");
  });
});
