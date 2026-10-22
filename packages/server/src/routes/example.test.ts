import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { EXAMPLE_PREFIX, exampleRoutes } from "./example.ts";
import { SITE_CSP } from "./preview.ts";
import { call, stubEntry, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
beforeAll(async () => {
  deps = await testDeps();
  app = createApp(deps, exampleRoutes(deps), { host: "pages" });
});
afterAll(async () => deps.db.close());

/** The snapshot `pnpm example:snapshot` writes: an index, then each project's entry and wiki. */
async function storeSnapshot() {
  const put = (key: string, body: string, type: string) =>
    deps.objects.put(`${EXAMPLE_PREFIX}${key}`, body, type);
  await put(
    "index.json",
    JSON.stringify({
      person: { login: "repowiki-app", displayName: "Jordan Avery" },
      projects: [{ slug: "alpha", publishedAt: "2026-10-21T12:00:00.000Z" }],
    }),
    "application/json",
  );
  await put(
    "alpha/entry.json",
    JSON.stringify(stubEntry("alpha", "repowiki-app/alpha")),
    "application/json",
  );
  await put(
    "alpha/site/index.html",
    "<!doctype html><h1>Alpha wiki</h1>",
    "text/html; charset=utf-8",
  );
}

describe("the example at /example (ADR-0017)", () => {
  it("is not found until a snapshot is stored", async () => {
    expect((await call(app, { path: "/example" })).status).toBe(404);
    expect((await call(app, { path: "/example/alpha/" })).status).toBe(404);
  });

  it("renders the stored snapshot as a biography that says it is an example", async () => {
    await storeSnapshot();
    const reply = await call(app, { path: "/example" });
    expect(reply.status).toBe(200);
    const html = String(reply.body);
    expect(html).toContain('<h1 class="page-title">Jordan Avery</h1>');
    expect(html).toContain("fictional");
    expect(html).toContain('href="/example/alpha/"');
    expect(html).toContain("https://github.com/repowiki-app");
    expect(html).not.toContain("Preview:");
  });

  it("serves each project's wiki under /example/<slug>/ and only the snapshot's projects", async () => {
    await storeSnapshot();
    const wiki = await call(app, { path: "/example/alpha/" });
    expect(wiki.status).toBe(200);
    expect(wiki.headers?.["content-security-policy"]).toBe(SITE_CSP);
    expect(Buffer.from(wiki.body as Uint8Array).toString()).toContain("Alpha wiki");
    expect((await call(app, { path: "/example/alpha" })).headers?.location).toBe("/example/alpha/");
    expect((await call(app, { path: "/example/" })).headers?.location).toBe("/example");
    expect((await call(app, { path: "/example/beta/" })).status).toBe(404);
    expect((await call(app, { path: "/example/beta" })).status).toBe(404);
    expect((await call(app, { path: "/example/..%2Findex.json" })).status).toBe(404);
  });
});
