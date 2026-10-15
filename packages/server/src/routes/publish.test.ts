import { isReservedHandle, REFUSALS, siteKey } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { App } from "../http/server.ts";
import { previewOf, versionOf } from "../store/drafts.ts";
import { projectById } from "../store/projects.ts";
import { draftRoutes } from "./drafts.ts";
import { previewRoutes } from "./preview.ts";
import { publishRoutes } from "./publish.ts";
import { call, form, generatedProject, otherCookie, testDeps } from "./test-app.ts";

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
const publishing = (hash: string, revision = 2) =>
  post(
    `/projects/${p.projectId}/publish`,
    `revision=${revision}&expectedVersion=0&previewHash=${hash}`,
  );
const project = () => projectById(deps.db, p.projectId);

/** Revision 2 written, reviewed and previewed; its preview hash. */
async function ready(): Promise<string> {
  await post(`/projects/${p.projectId}/revisions`, "baseRevision=1&contribution=Mine.");
  await post(`/projects/${p.projectId}/review`, "revision=2&attest=yes");
  await post(`/projects/${p.projectId}/preview`, "revision=2");
  return (await previewOf(deps.db, p.projectId, 2))?.siteHash ?? "";
}

/** Every file under a prefix, by path inside it. */
async function tree(prefix: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const key of await deps.objects.list(prefix)) {
    const object = await deps.objects.get(key);
    files.set(key.slice(prefix.length), Buffer.from(object?.body ?? []).toString("base64"));
  }
  return files;
}

beforeEach(async () => {
  deps = await testDeps();
  app = createApp(deps, [...draftRoutes(deps), ...previewRoutes(deps), ...publishRoutes(deps)]);
  p = await generatedProject(deps);
});
afterEach(async () => deps.db.close());

describe("publish (Contract §6.4)", () => {
  it("publishes only the previewed files when an earlier attempt left some behind (fresh review I2)", async () => {
    const hash = await ready();
    const target = siteKey(p.projectId, 1);
    await deps.objects.put(
      `${target}docs/never-previewed.html`,
      Buffer.from("<p>stale</p>"),
      "text/html",
    );
    expect((await publishing(hash)).status).toBe(303);
    const preview = await previewOf(deps.db, p.projectId, 2);
    expect(await tree(target)).toEqual(await tree(preview?.siteKey ?? ""));
    expect((await tree(target)).has("docs/never-previewed.html")).toBe(false);
  }, 300_000);

  it("copies the previewed tree byte for byte to version 1 and marks the project published", async () => {
    const hash = await ready();
    const page = String(
      (await call(app, { path: `/projects/${p.projectId}`, headers: { cookie: p.cookie } })).body,
    );
    expect(page).toContain(`href="/preview/${p.projectId}/2/"`);
    expect(page).toContain(`name="previewHash" value="${hash}"`);
    expect((await publishing(hash)).status).toBe(303);
    expect(await project()).toMatchObject({ state: "published", currentVersion: 1 });
    const version = await versionOf(deps.db, p.projectId, 1);
    expect(version).toMatchObject({
      revision: 2,
      siteHash: hash,
      siteKey: `sites/${p.projectId}/v1/`,
    });
    const previewed = await tree((await previewOf(deps.db, p.projectId, 2))?.siteKey ?? "x/");
    expect(previewed.size).toBeGreaterThan(10);
    expect(await tree(`sites/${p.projectId}/v1/`)).toEqual(previewed);
    // Publishing the same revision again changes nothing.
    expect((await publishing(hash)).status).toBe(303);
    expect((await project())?.currentVersion).toBe(1);
  }, 300_000);

  it("refuses a hash the author did not see, a revision saved after its preview, and another account", async () => {
    const hash = await ready();
    expect((await publishing("0".repeat(64))).status).toBe(REFUSALS["preview-mismatch"].status);
    const other = await otherCookie(deps);
    const theirs = await post(
      `/projects/${p.projectId}/publish`,
      `revision=2&expectedVersion=0&previewHash=${hash}`,
      other,
    );
    expect(theirs.status).toBe(404);
    await post(`/projects/${p.projectId}/revisions`, "baseRevision=2&contribution=Changed.");
    expect((await publishing(hash)).status).toBe(REFUSALS["stale-revision"].status);
    expect((await project())?.state).toBe("draft");
  }, 300_000);

  it("refuses a preview whose stored file changed after it was hashed (A1)", async () => {
    const hash = await ready();
    const preview = await previewOf(deps.db, p.projectId, 2);
    await deps.objects.put(
      `${preview?.siteKey}docs/index.html`,
      "<p>changed</p>",
      "text/html; charset=utf-8",
    );
    expect((await publishing(hash)).status).toBe(REFUSALS["preview-mismatch"].status);
    expect(await versionOf(deps.db, p.projectId, 1)).toBeNull();
    expect(await deps.objects.list(`sites/${p.projectId}/`)).toEqual([]);
    expect((await project())?.state).toBe("draft");
  }, 300_000);

  it("unpublishes at once, for the owner only", async () => {
    await publishing(await ready());
    const other = await otherCookie(deps);
    expect((await post(`/projects/${p.projectId}/unpublish`, "", other)).status).toBe(404);
    expect((await project())?.state).toBe("published");
    expect((await post(`/projects/${p.projectId}/unpublish`, "")).status).toBe(303);
    expect(await project()).toMatchObject({ state: "withdrawn", withdrawReason: "author" });
  }, 300_000);
});

describe("app paths (Contract §9)", () => {
  it("reserves the server's top-level paths as handles", () => {
    for (const name of ["internal", "llm", "preview", "projects"])
      expect(isReservedHandle(name)).toBe(true);
  });
});
