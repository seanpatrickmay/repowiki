import { REFUSALS } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { buildTree } from "../render/build.ts";
import { treeHash } from "../render/tree.ts";
import { previewOf } from "../store/drafts.ts";
import { draftRoutes } from "./drafts.ts";
import { previewRoutes, serveTreeFile } from "./preview.ts";
import { auditOutcomes, call, form, generatedProject, otherCookie, testDeps } from "./test-app.ts";

let deps: Deps;
let app: App;
let p: { projectId: string; cookie: string; csrf: string };
const post = (path: string, body: string, who: { cookie: string; csrf: string } = p) =>
  call(app, {
    method: "POST",
    path,
    headers: form(who.cookie, deps.config.origin),
    body: `csrf=${who.csrf}&${body}`,
  });
const get = (path: string, cookie = p.cookie) => call(app, { path, headers: { cookie } });

beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, [...draftRoutes(deps), ...previewRoutes(deps)]);
  p = await generatedProject(deps);
});
afterEach(async () => deps.db.close());

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
    const page = await serveTreeFile(deps.objects, prefix, "docs/", from, "/preview/p/1/docs/");
    expect(String(page?.body)).toContain('href="/preview/p/1/docs/wiki/x/"');
    expect(String(page?.body)).toContain('href="https://github.com/demo-dev/demo-repo/docs/a"');
    expect((await serveTreeFile(deps.objects, prefix, "docs/wiki/x"))?.body).toBeDefined();
    const png = await serveTreeFile(deps.objects, prefix, "docs/a.png", "/a/", "/b/");
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
    await post(`/projects/${p.projectId}/revisions`, "baseRevision=1&contribution=Mine.");
    const stale = await post(`/projects/${p.projectId}/preview`, "revision=1");
    expect(stale.status).toBe(REFUSALS["stale-revision"].status);
    expect((await post(`/projects/${p.projectId}/preview`, "revision=2")).status).toBe(303);
    const preview = await previewOf(deps.db, p.projectId, 2);
    expect(preview?.siteKey).toBe(`previews/${p.projectId}/r2/${preview?.siteHash}/`);
    // The stored tree is exactly what was hashed (A1).
    const keys = await deps.objects.list(preview?.siteKey ?? "x/");
    const files = await Promise.all(
      keys.map(async (key) => ({
        path: key.slice(preview?.siteKey.length ?? 0),
        bytes: (await deps.objects.get(key))?.body ?? new Uint8Array(),
      })),
    );
    expect(treeHash(files)).toBe(preview?.siteHash);

    const base = `/preview/${p.projectId}/2/`;
    const home = await get(base);
    expect(home.status).toBe(200);
    expect(String(home.body)).toContain("Preview: only you can see this page");
    expect(String(home.body)).toContain("Mine.");
    expect(home.headers?.["cache-control"]).toBe("private, no-store");
    const wiki = await get(`${base}docs/`);
    expect(wiki.status).toBe(200);
    expect(wiki.headers?.["content-security-policy"]).toContain("wasm-unsafe-eval");
    expect(String(wiki.body)).toContain(`${base}docs/`);
    expect(String(wiki.body)).not.toContain('"/demo-dev/demo-repo/docs/');
    expect(String(wiki.body)).not.toContain("github.com/preview/");
    // Every wiki page is public (ADR-0012).
    expect((await get(`${base}docs/wiki/${first}/`)).status).toBe(200);
    expect((await get(`${base}docs/wiki/signals/`)).status).toBe(200);
    expect((await get(`${base}portfolio.json`)).status).toBe(404);
    expect((await get(`/preview/${p.projectId}/2`)).status).toBe(301);

    expect((await call(app, { path: base })).status).toBe(404);
    const other = await otherCookie(deps);
    expect((await get(base, other.cookie)).status).toBe(404);
    expect((await get(`/preview/${p.projectId}/1/`)).status).toBe(404);
    expect((await post(`/projects/${p.projectId}/preview`, "revision=2", other)).status).toBe(404);
  }, 300_000);

  it("audits a refused build, the stale-revision path included (spec 2 S5)", async () => {
    await post(`/projects/${p.projectId}/revisions`, "baseRevision=1&contribution=Mine.");
    const stale = await post(`/projects/${p.projectId}/preview`, "revision=1");
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
    const saved = await post(
      `/projects/${p.projectId}/revisions`,
      "baseRevision=1&contribution=Mine.",
    );
    expect(saved.status).toBe(303);
    release();
    expect((await building).status).toBe(REFUSALS["stale-revision"].status);
    expect(await previewOf(deps.db, p.projectId, 1)).toBeNull();
    expect(await auditOutcomes(deps.db, "preview.build", p.projectId)).toEqual(["stale-revision"]);
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
