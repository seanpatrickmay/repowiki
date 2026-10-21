import { REFUSALS } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { buildTree } from "../render/build.ts";
import { treeHash } from "../render/tree.ts";
import { previewOf } from "../store/drafts.ts";
import { draftRoutes } from "./drafts.ts";
import { previewPageRoutes, previewRoutes, serveTreeFile } from "./preview.ts";
import {
  auditOutcomes,
  call,
  form,
  generatedProject,
  otherCookie,
  publishedStub,
  refreshed,
  testDeps,
} from "./test-app.ts";

let deps: Deps;
let app: App;
let pages: App;
let p: { projectId: string; cookie: string; csrf: string; accountId: string };
const post = (path: string, body: string, who: { cookie: string; csrf: string } = p) =>
  call(app, {
    method: "POST",
    path,
    headers: form(who.cookie, deps.config.appOrigin),
    body: `csrf=${who.csrf}&${body}`,
  });
const get = (path: string, cookie = p.cookie) => call(app, { path, headers: { cookie } });

beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, [...draftRoutes(deps), ...previewRoutes(deps)]);
  pages = createApp(deps, previewPageRoutes(deps), { host: "pages" });
  p = await generatedProject(deps);
});
afterEach(async () => deps.db.close());

/** Polls `done` until it holds; a background build has no completion signal of its own. */
async function until(done: () => Promise<boolean>, ms = 120_000) {
  for (const start = Date.now(); !(await done()); ) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("serveTreeFile (spec 2 S13)", () => {
  it("rewrites the public base in text files only, serves directories, refuses escapes", async () => {
    const html =
      '<a href="/demo-dev/demo-repo/docs/wiki/x/">x</a><a href="https://github.com/demo-dev/demo-repo/docs/a">gh</a>';
    await deps.objects.put("previews/p/r1/h/docs/index.html", html, "text/html; charset=utf-8");
    await deps.objects.put(
      "previews/p/r1/h/docs/wiki/x/index.html",
      html,
      "text/html; charset=utf-8",
    );
    await deps.objects.put("previews/p/r1/h/docs/a.png", new Uint8Array([1, 2]), "image/png");
    const prefix = "previews/p/r1/h/";
    const from = "/demo-dev/demo-repo/docs/";
    const page = await serveTreeFile(deps.objects, prefix, "docs/", [[from, "/preview/p/1/docs/"]]);
    expect(String(page?.body)).toContain('href="/preview/p/1/docs/wiki/x/"');
    expect(String(page?.body)).toContain('href="https://github.com/demo-dev/demo-repo/docs/a"');
    expect((await serveTreeFile(deps.objects, prefix, "docs/wiki/x"))?.body).toBeDefined();
    const png = await serveTreeFile(deps.objects, prefix, "docs/a.png", [["/a/", "/b/"]]);
    expect(png?.body).toEqual(new Uint8Array([1, 2]));
    const asStored = await serveTreeFile(deps.objects, prefix, "docs/");
    expect(new TextDecoder().decode(asStored?.body as Uint8Array)).toBe(html);
    // A real file where the dot segments would land, so only the refusal keeps it out.
    await deps.objects.put("previews/p/r1/x", new TextEncoder().encode("outside"), "text/plain");
    expect(await serveTreeFile(deps.objects, prefix, "docs/../../x")).toBeNull();
    expect(await serveTreeFile(deps.objects, prefix, "docs/missing.html")).toBeNull();
  });
});

describe("previews (spec 2 §7, S13; M14e A1, A3, A5)", () => {
  it("builds the latest revision's exact tree under its hash and serves it to the owner only", async () => {
    const first = "deliverables";
    const stale = await post(`/projects/${p.projectId}/preview`, "revision=2");
    expect(stale.status).toBe(REFUSALS["stale-revision"].status);
    expect((await post(`/projects/${p.projectId}/preview`, "revision=1")).status).toBe(303);
    const preview = await previewOf(deps.db, p.projectId, 1);
    expect(preview?.siteKey).toBe(`previews/${p.projectId}/r1/${preview?.siteHash}/`);
    // The stored tree is exactly what was hashed (A1).
    const keys = await deps.objects.list(preview?.siteKey ?? "x/");
    const files = await Promise.all(
      keys.map(async (key) => ({
        path: key.slice(preview?.siteKey.length ?? 0),
        bytes: (await deps.objects.get(key))?.body ?? new Uint8Array(),
      })),
    );
    expect(treeHash(files)).toBe(preview?.siteHash);

    // The app mints a link on the pages origin; the pages host serves it (ADR-0012).
    const opened = await post(`/projects/${p.projectId}/preview/open`, "revision=1");
    expect(opened.status).toBe(303);
    const location = String(opened.headers?.location);
    const prefix = `${deps.config.publicOrigin}/_preview/`;
    expect(location.startsWith(prefix)).toBe(true);
    const base = location.slice(deps.config.publicOrigin.length);
    expect(base).toMatch(/^\/_preview\/[A-Za-z0-9_-]{43}\/$/);
    const home = await call(pages, { path: base, headers: { cookie: p.cookie } });
    expect(home.status).toBe(200);
    expect(String(home.body)).toContain("Preview: a private link that expires within an hour");
    expect(String(home.body)).toContain("I wrote the ingest code.");
    expect(home.headers).toMatchObject({
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
    });
    expect(home.headers?.["set-cookie"]).toBeUndefined();
    // The preview's biography links to the preview's wiki, at the project's slug (ADR-0013).
    const at = `${base}demo-repo/`;
    expect(String(home.body)).toContain(`href="${at}">Read the wiki</a>`);
    const wiki = await call(pages, { path: at });
    expect(wiki.status).toBe(200);
    expect(wiki.headers?.["content-security-policy"]).toContain("wasm-unsafe-eval");
    expect(wiki.headers?.["x-robots-tag"]).toBe("noindex");
    expect(String(wiki.body)).toContain(`${at}wiki/`);
    expect(String(wiki.body)).not.toContain('"/demo-dev/demo-repo/');
    // Its link to the author's biography goes to the preview's biography (ADR-0013).
    expect(String(wiki.body)).toContain(`<a href="${base}">Demo Developer</a>`);
    expect(String(wiki.body)).not.toContain('href="/demo-dev"');
    expect(String(wiki.body)).not.toContain("github.com/_preview/");
    // Every wiki page is public (ADR-0012).
    expect((await call(pages, { path: `${at}wiki/${first}/` })).status).toBe(200);
    expect((await call(pages, { path: `${at}wiki/signals/` })).status).toBe(200);
    expect((await call(pages, { path: `${base}demo-repo` })).headers?.location).toBe(at);
    expect((await call(pages, { path: `${base}entry.json` })).status).toBe(404);
    expect((await call(pages, { path: `${base}docs/` })).status).toBe(404);
    expect((await call(pages, { path: base.slice(0, -1) })).status).toBe(301);
    expect((await call(pages, { path: `/_preview/${"A".repeat(43)}/` })).status).toBe(404);

    // An hour on, the link is gone.
    const hourLater = { ...deps, now: () => "2026-10-14T13:00:00.000Z" };
    const laterPages = createApp(hourLater, previewPageRoutes(hourLater), { host: "pages" });
    expect((await call(laterPages, { path: base })).status).toBe(404);

    // The old session-read preview on the app origin is gone.
    expect((await get(`/preview/${p.projectId}/1/`)).status).toBe(404);
    const other = await otherCookie(deps);
    expect((await post(`/projects/${p.projectId}/preview/open`, "revision=1", other)).status).toBe(
      404,
    );
    expect((await post(`/projects/${p.projectId}/preview`, "revision=1", other)).status).toBe(404);
    // The latest revision with no preview yet has no link.
    await refreshed(deps, p.projectId);
    expect((await post(`/projects/${p.projectId}/preview/open`, "revision=2")).status).toBe(404);
  }, 300_000);

  it("audits a refused build, the stale-revision path included (spec 2 S5)", async () => {
    const stale = await post(`/projects/${p.projectId}/preview`, "revision=2");
    expect(stale.status).toBe(REFUSALS["stale-revision"].status);
    expect(await auditOutcomes(deps.db, "preview.build", p.projectId)).toEqual(["stale-revision"]);
  });

  it("saves no preview for a revision that stopped being the latest while it built", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow: typeof buildTree = async (input) => {
      entered();
      await held;
      return buildTree(input);
    };
    app = createApp(deps, [...draftRoutes(deps), ...previewRoutes(deps, slow)]);
    const building = post(`/projects/${p.projectId}/preview`, "revision=1");
    await started;
    await refreshed(deps, p.projectId);
    release();
    expect((await building).status).toBe(REFUSALS["stale-revision"].status);
    expect(await previewOf(deps.db, p.projectId, 1)).toBeNull();
    expect(await auditOutcomes(deps.db, "preview.build", p.projectId)).toEqual(["stale-revision"]);
  }, 300_000);

  it("opens only the latest revision's preview (review fix)", async () => {
    expect((await post(`/projects/${p.projectId}/preview`, "revision=1")).status).toBe(303);
    await refreshed(deps, p.projectId);
    const opened = await post(`/projects/${p.projectId}/preview/open`, "revision=1");
    expect(opened.status).toBe(REFUSALS["stale-revision"].status);
  }, 300_000);

  it("closes a link once the project is taken down or its owner is being deleted (review fix)", async () => {
    expect((await post(`/projects/${p.projectId}/preview`, "revision=1")).status).toBe(303);
    const link = async () => {
      const opened = await post(`/projects/${p.projectId}/preview/open`, "revision=1");
      return String(opened.headers?.location).slice(deps.config.publicOrigin.length);
    };
    const taken = await link();
    const deleting = await link();
    expect((await call(pages, { path: taken })).status).toBe(200);
    await deps.db.query(
      `UPDATE projects SET body = body || '{"state":"withdrawn","withdrawReason":"operator","withdrawnAt":"2026-10-14T12:00:00.000Z"}'::jsonb WHERE id = $1`,
      [p.projectId],
    );
    expect((await call(pages, { path: taken })).status).toBe(404);
    await deps.db.query(
      `UPDATE projects SET body = body || '{"state":"draft","withdrawReason":null,"withdrawnAt":null}'::jsonb WHERE id = $1`,
      [p.projectId],
    );
    expect((await call(pages, { path: deleting })).status).toBe(200);
    await deps.db.query(
      "UPDATE accounts SET body = jsonb_set(body, '{status}', '\"deleting\"') WHERE id = $1",
      [p.accountId],
    );
    expect((await call(pages, { path: deleting })).status).toBe(404);
  }, 300_000);

  it("refuses to open a link without the CSRF token or from another origin (review fix)", async () => {
    expect((await post(`/projects/${p.projectId}/preview`, "revision=1")).status).toBe(303);
    const path = `/projects/${p.projectId}/preview/open`;
    const noToken = await call(app, {
      method: "POST",
      path,
      headers: form(p.cookie, deps.config.appOrigin),
      body: "revision=1",
    });
    expect(noToken.status).toBe(403);
    const foreign = await call(app, {
      method: "POST",
      path,
      headers: form(p.cookie, deps.config.publicOrigin),
      body: `csrf=${p.csrf}&revision=1`,
    });
    expect(foreign.status).toBe(403);
    expect(await deps.db.query("SELECT 1 FROM preview_tokens")).toHaveLength(0);
  }, 300_000);

  it("links the account's other projects to their public wikis, and needs a handle (review M3, M4)", async () => {
    await publishedStub(deps, p.accountId, "other", 777);
    expect((await post(`/projects/${p.projectId}/preview`, "revision=1")).status).toBe(303);
    const opened = await post(`/projects/${p.projectId}/preview/open`, "revision=1");
    const base = String(opened.headers?.location).slice(deps.config.publicOrigin.length);
    const bio = String((await call(pages, { path: base })).body);
    expect(bio).toContain('href="/demo-dev/other/">Read the wiki</a>');
    expect(bio).toContain(`href="${base}demo-repo/">Read the wiki</a>`);
    // With no active handle there is no public path to rewrite from: no preview at all.
    await deps.db.query("UPDATE handles SET body = jsonb_set(body, '{state}', '\"tombstoned\"')");
    expect((await call(pages, { path: base })).status).toBe(404);
    expect((await call(pages, { path: `${base}demo-repo/` })).status).toBe(404);
  }, 300_000);

  it("answers a slow build at once, shows it building, and finishes it in the background", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: typeof buildTree = async (input) => {
      await held;
      return buildTree(input);
    };
    app = createApp(deps, [...draftRoutes(deps), ...previewRoutes(deps, slow, { waitMs: 20 })]);
    const answered = await post(`/projects/${p.projectId}/preview`, "revision=1");
    expect(answered.status).toBe(303);
    expect(answered.headers?.location).toBe(`/projects/${p.projectId}`);
    const building = String((await get(`/projects/${p.projectId}`)).body);
    expect(building).toContain("Building the preview of revision 1");
    expect(building).toContain('<meta http-equiv="refresh"');
    expect(building).not.toContain("Build preview of revision 1</button>");
    release();
    await until(async () => (await previewOf(deps.db, p.projectId, 1)) !== null);
    const ready = String((await get(`/projects/${p.projectId}`)).body);
    expect(ready).toContain("Open the preview of revision 1");
    expect(ready).not.toContain("Building the preview");
  }, 300_000);

  it("says a build that failed in the background failed, and offers to build again", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const broken: typeof buildTree = async () => {
      await held;
      throw new Error("astro exploded");
    };
    const logged: object[] = [];
    deps.log = (line) => logged.push(line);
    app = createApp(deps, [...draftRoutes(deps), ...previewRoutes(deps, broken, { waitMs: 20 })]);
    expect((await post(`/projects/${p.projectId}/preview`, "revision=1")).status).toBe(303);
    release();
    await until(async () => logged.length > 0);
    const shown = String((await get(`/projects/${p.projectId}`)).body);
    expect(shown).toContain("The preview could not be built. Try again.");
    expect(shown).toContain("Build preview of revision 1</button>");
    expect(shown).not.toContain("Building the preview");
    // The log names the error, never its message.
    expect(JSON.stringify(logged)).not.toContain("astro exploded");
  }, 300_000);

  it("shows nothing of a background build once its revision is no longer the latest", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: typeof buildTree = async (input) => {
      await held;
      return buildTree(input);
    };
    app = createApp(deps, [...draftRoutes(deps), ...previewRoutes(deps, slow, { waitMs: 20 })]);
    expect((await post(`/projects/${p.projectId}/preview`, "revision=1")).status).toBe(303);
    await refreshed(deps, p.projectId);
    release();
    await until(
      async () => (await auditOutcomes(deps.db, "preview.build", p.projectId)).length > 0,
    );
    expect(await auditOutcomes(deps.db, "preview.build", p.projectId)).toEqual(["stale-revision"]);
    const shown = String((await get(`/projects/${p.projectId}`)).body);
    expect(shown).not.toContain("Building the preview");
    expect(shown).not.toContain(REFUSALS["stale-revision"].message);
    expect(await previewOf(deps.db, p.projectId, 1)).toBeNull();
  }, 300_000);

  it("allows one preview build in flight per account (A3)", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: typeof buildTree = async (input) => {
      await held;
      return buildTree(input);
    };
    app = createApp(deps, [...draftRoutes(deps), ...previewRoutes(deps, slow)]);
    const first = post(`/projects/${p.projectId}/preview`, "revision=1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await post(`/projects/${p.projectId}/preview`, "revision=1");
    expect(second.status).toBe(429);
    expect(String(second.body)).toContain("A preview is already being built.");
    expect(second.headers?.["cache-control"]).toBe("private, no-store");
    release();
    expect((await first).status).toBe(303);
  }, 300_000);
});
