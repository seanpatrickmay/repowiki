import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { previewOf, versionOf } from "../store/drafts.ts";
import { projectById, saveProject } from "../store/projects.ts";
import { draftRoutes } from "./drafts.ts";
import { previewRoutes } from "./preview.ts";
import { publicRoutes } from "./public.ts";
import { publishRoutes } from "./publish.ts";
import { call, form, generatedProject, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let p: { projectId: string; cookie: string; csrf: string; accountId: string };
const post = (path: string, body: string) =>
  call(app, {
    method: "POST",
    path,
    headers: form(p.cookie, deps.config.appOrigin),
    body: `csrf=${p.csrf}&${body}`,
  });
const get = (path: string) => call(app, { path });
const PAGE = "/demo-dev/demo-repo";
const WIKI = `${PAGE}/`;

beforeAll(async () => {
  deps = await testDeps();
  app = createApp(deps, [
    ...draftRoutes(deps),
    ...previewRoutes(deps),
    ...publishRoutes(deps),
    ...publicRoutes(deps),
  ]);
  p = await generatedProject(deps, { contributionDraft: 'Mine: a "tiny" demo & <3 more.' });
  await post(`/projects/${p.projectId}/review`, "revision=1&attest=yes");
}, 300_000);
afterAll(async () => deps.db.close());

describe("public pages (spec 2 S14; Contract §9)", () => {
  it("serves nothing before publishing", async () => {
    expect((await get(WIKI)).status).toBe(404);
    // No published project, no biography (ADR-0013).
    expect((await get("/demo-dev")).status).toBe(404);
    await post(`/projects/${p.projectId}/preview`, "revision=1");
    const hash = (await previewOf(deps.db, p.projectId, 1))?.siteHash ?? "";
    expect(
      (
        await post(
          `/projects/${p.projectId}/publish`,
          `revision=1&expectedVersion=0&previewHash=${hash}`,
        )
      ).status,
    ).toBe(303);
  }, 300_000);

  it("serves the biography signed out, escaped, linking to the wiki, cached for 60 seconds", async () => {
    const reply = await get("/demo-dev");
    expect(reply.status).toBe(200);
    const body = String(reply.body);
    expect(body).toContain('<h1 class="page-title">Demo Developer</h1>');
    expect(body).toContain("Mine: a &quot;tiny&quot; demo &amp; &lt;3 more.");
    expect(body).not.toContain("<3");
    expect(body).toContain(`href="${WIKI}">Read the wiki</a>`);
    expect(body).toContain('<link rel="stylesheet" href="/_app/biography.css">');
    expect(body).not.toContain("<style");
    // Public pages point readers at the app on its own origin (ADR-0012).
    expect(body).toContain(`<a href="${deps.config.appOrigin}/">Made with RepoWiki</a>`);
    expect(reply.headers?.["cache-control"]).toBe("public, max-age=60");
    expect(reply.headers?.["set-cookie"]).toBeUndefined();
  });

  it("serves the published wiki's bytes as copied at the project's root, and 404s for anything else", async () => {
    const home = await get(WIKI);
    expect(home.status).toBe(200);
    expect(home.headers?.["content-security-policy"]).toContain("wasm-unsafe-eval");
    expect(home.headers?.["cache-control"]).toBe("public, max-age=60");
    const version = await versionOf(deps.db, p.projectId, 1);
    const stored = await deps.objects.get(`${version?.siteKey}site/index.html`);
    expect(home.body).toEqual(stored?.body);
    expect(new TextDecoder().decode(home.body as Uint8Array)).toContain(`${WIKI}wiki/`);
    expect((await get(`${WIKI}wiki/signals/`)).status).toBe(200);
    expect((await get(`${WIKI}wiki/deliverables/`)).status).toBe(200);
    expect((await get(`${WIKI}nope.html`)).status).toBe(404);
    // The old /docs/ paths never launched, and the entry is not a page.
    expect((await get(`${WIKI}docs/`)).status).toBe(404);
    expect((await get(`${WIKI}entry.json`)).status).toBe(404);
    expect((await get("/demo-dev/nope")).status).toBe(404);
    expect((await get("/nobody-here")).status).toBe(404);
    expect((await get(PAGE)).headers?.location).toBe(WIKI);
    expect((await get("/Demo-Dev/demo-repo")).headers?.location).toBe(WIKI);
  });

  it("never redirects off the site, and redirects only to canonical paths (fresh review I1)", async () => {
    for (const path of ["/%09/evil.com/", "/%5Cevil.com/x/", "/%09/evil.com", "/%5C%5Cevil.com"]) {
      const reply = await get(path);
      expect(reply.status, path).toBe(404);
      expect(reply.headers?.location, path).toBeUndefined();
    }
    expect((await get("/demo-dev/%09evil.com/")).status).toBe(404);
    expect((await get("/demo-dev/nope/")).status).toBe(404);
    expect((await get("/demo-dev/nope/wiki")).status).toBe(404);
    const bare = await get(PAGE);
    expect(bare.status).toBe(301);
    expect(bare.headers?.location).toBe(WIKI);
  });

  it("sends another case of a slug, and a handle's trailing slash, to the canonical path", async () => {
    const cased = await get("/demo-dev/Demo-Repo");
    expect(cased.status).toBe(301);
    expect(cased.headers?.location).toBe(WIKI);
    expect((await get("/Demo-Dev/Demo-Repo/wiki/signals/")).headers?.location).toBe(
      `${WIKI}wiki/signals/`,
    );
    const profile = await get("/demo-dev/");
    expect(profile.status).toBe(301);
    expect(profile.headers?.location).toBe("/demo-dev");
    expect((await get("/Demo-Dev/")).headers?.location).toBe("/demo-dev");
    expect((await get("/nobody-here/")).status).toBe(404);
  });

  it("sends a renamed handle's pages to the new handle, but only pages that exist", async () => {
    await deps.db.query(
      "INSERT INTO handles (handle, account_id, body) VALUES ($1, $2, $3::jsonb)",
      [
        "old-dev",
        p.accountId,
        JSON.stringify({
          handle: "old-dev",
          accountId: p.accountId,
          state: "redirect",
          redirectTo: "demo-dev",
          createdAt: "2026-10-14T12:00:00.000Z",
        }),
      ],
    );
    expect((await get("/old-dev")).headers?.location).toBe("/demo-dev");
    expect((await get("/old-dev/demo-repo")).headers?.location).toBe(WIKI);
    const deep = await get("/old-dev/demo-repo/wiki/signals/");
    expect(deep.headers?.location).toBe(`${WIKI}wiki/signals/`);
    expect((await get("/old-dev/nope")).status).toBe(404);
  });

  it("answers 410 for a withdrawn wiki at once and drops it from the biography", async () => {
    await post(`/projects/${p.projectId}/unpublish`, "");
    expect((await get(WIKI)).status).toBe(410);
    expect((await get(`${WIKI}wiki/signals/`)).status).toBe(410);
    // Its only published project gone, the biography is gone too.
    expect((await get("/demo-dev")).status).toBe(404);
  });

  it("says a page taken down by the operator was removed, not withdrawn by its author", async () => {
    const project = await projectById(deps.db, p.projectId);
    if (project === null) throw new Error("project");
    await saveProject(deps.db, { ...project, withdrawReason: "operator" });
    const reply = await get(WIKI);
    expect(reply.status).toBe(410);
    expect(String(reply.body)).toBe("This page was removed.");
  });
});
