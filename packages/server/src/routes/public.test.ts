import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { previewOf, versionOf } from "../store/drafts.ts";
import { draftRoutes } from "./drafts.ts";
import { previewRoutes } from "./preview.ts";
import { publicRoutes } from "./public.ts";
import { publishRoutes } from "./publish.ts";
import { call, form, generatedProject, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let p: { projectId: string; cookie: string; csrf: string };
const post = (path: string, body: string) =>
  call(app, {
    method: "POST",
    path,
    headers: form(p.cookie, deps.config.origin),
    body: `csrf=${p.csrf}&${body}`,
  });
const get = (path: string) => call(app, { path });
const PAGE = "/demo-dev/demo-repo";

beforeAll(async () => {
  deps = await testDeps();
  app = createApp(deps, [
    ...draftRoutes(deps),
    ...previewRoutes(deps),
    ...publishRoutes(deps),
    ...publicRoutes(deps),
  ]);
  p = await generatedProject(deps);
  const tagline = encodeURIComponent('A "tiny" demo & <3 more');
  await post(
    `/projects/${p.projectId}/revisions`,
    `baseRevision=1&contribution=Mine.&tagline=${tagline}&hidden=deliverables`,
  );
  await post(`/projects/${p.projectId}/review`, "revision=2&attest=yes");
}, 300_000);
afterAll(async () => deps.db.close());

describe("public pages (spec 2 S14; Contract §9)", () => {
  it("serves nothing before publishing", async () => {
    expect((await get(PAGE)).status).toBe(404);
    expect((await get(`${PAGE}/docs/`)).status).toBe(404);
    expect(String((await get("/demo-dev")).body)).not.toContain(`href="${PAGE}"`);
    await post(`/projects/${p.projectId}/preview`, "revision=2");
    const hash = (await previewOf(deps.db, p.projectId, 2))?.siteHash ?? "";
    expect(
      (
        await post(
          `/projects/${p.projectId}/publish`,
          `revision=2&expectedVersion=0&previewHash=${hash}`,
        )
      ).status,
    ).toBe(303);
  }, 300_000);

  it("serves the portfolio page signed out, escaped, cached for 60 seconds", async () => {
    const reply = await get(PAGE);
    expect(reply.status).toBe(200);
    const body = String(reply.body);
    expect(body).toContain("Mine.");
    expect(body).toContain("Author-reviewed");
    expect(body).toMatch(/Published 20\d\d-\d\d-\d\d/);
    expect(body).toContain("A &quot;tiny&quot; demo &amp; &lt;3 more");
    expect(body).not.toContain("<3");
    expect(reply.headers?.["cache-control"]).toBe("public, max-age=60");
    expect(reply.headers?.["set-cookie"]).toBeUndefined();
  });

  it("serves the published wiki's bytes as copied, and 404s for anything else", async () => {
    const home = await get(`${PAGE}/docs/`);
    expect(home.status).toBe(200);
    expect(home.headers?.["content-security-policy"]).toContain("wasm-unsafe-eval");
    expect(home.headers?.["cache-control"]).toBe("public, max-age=60");
    const version = await versionOf(deps.db, p.projectId, 1);
    const stored = await deps.objects.get(`${version?.siteKey}docs/index.html`);
    expect(home.body).toEqual(stored?.body);
    expect((await get(`${PAGE}/docs/wiki/signals/`)).status).toBe(200);
    expect((await get(`${PAGE}/docs/wiki/deliverables/`)).status).toBe(404);
    expect((await get(`${PAGE}/docs/nope.html`)).status).toBe(404);
    expect((await get(`${PAGE}/portfolio.json`)).status).toBe(404);
    expect((await get("/demo-dev/nope")).status).toBe(404);
    expect((await get("/nobody-here")).status).toBe(404);
    expect((await get(`${PAGE}/`)).status).toBe(301);
    expect((await get("/Demo-Dev/demo-repo")).headers?.location).toBe(PAGE);
  });

  it("lists published projects on the profile, escaped", async () => {
    const reply = await get("/demo-dev");
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain(`href="${PAGE}"`);
    expect(String(reply.body)).toContain("&lt;3 more");
    expect(String(reply.body)).not.toContain("<3");
    expect(String(reply.body)).not.toContain("<style");
  });

  it("answers 410 for a withdrawn page at once and drops it from the profile", async () => {
    await post(`/projects/${p.projectId}/unpublish`, "");
    expect((await get(PAGE)).status).toBe(410);
    expect((await get(`${PAGE}/docs/`)).status).toBe(410);
    expect(String((await get("/demo-dev")).body)).not.toContain(`href="${PAGE}"`);
  });
});
