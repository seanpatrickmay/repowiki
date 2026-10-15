import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { GITHUB } from "./github/endpoints.ts";
import { call, freePort } from "./routes/test-app.ts";
import { freshDb } from "./store/test-db.ts";
import { buildDeps, listenersFor, routeSets, startServer, workerMode } from "./wiring.ts";

const DEMO = { REPOWIKI_MODE: "demo" };
const PRODUCTION = {
  REPOWIKI_MODE: "production",
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

const top = (routes: { pattern: string }[]) => new Set(routes.map((r) => r.pattern.split("/")[1]));

describe("route sets (spec 2 S1)", () => {
  it("keeps the worker's routes off the public set, and handles last", async () => {
    const deps = await buildDeps(loadConfig(DEMO));
    const sets = routeSets(deps);
    expect(top(sets.public).has("internal")).toBe(false);
    expect(top(sets.public).has("llm")).toBe(false);
    expect([...top(sets.worker)].sort()).toEqual(["internal", "llm"]);
    expect(sets.public[0]?.pattern).toBe("/");
    expect(sets.public.slice(-2).map((r) => r.pattern)).toEqual(["/:handle/:slug/*", "/:handle/*"]);
    await deps.db.close();
  });

  it("wires the demo with fakes for GitHub, the model and the worker", async () => {
    const deps = await buildDeps(loadConfig(DEMO));
    expect(deps.config.github.kind).toBe("fake");
    expect(deps.github.web).toBe(`${deps.config.origin}/_fake/github`);
    expect(deps.anthropic).toMatchObject({ url: "https://api.anthropic.test", key: "demo" });
    expect(workerMode(deps.config)).toBe("fixture");
    await deps.db.close();
  });

  it("runs the engine locally only with real GitHub and a model key", () => {
    const dev = { REPOWIKI_MODE: "development", DATA_DIR: "/tmp/rw" };
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
    for (const path of ["/internal/job/lease", "/llm/v1/messages", "/internal", "/llm"]) {
      expect((await call(pub.app, { method: "POST", path })).status, path).toBe(404);
      expect((await call(pub.app, { path: `${path}/x` })).status, path).toBe(404);
    }
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
    expect((await call(only.app, { method: "POST", path: "/internal/job/lease" })).status).toBe(
      401,
    );
    expect((await call(only.app, { path: "/" })).status).toBe(200);
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
});
