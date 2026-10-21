import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { FIXTURE_FEATURES, freePort } from "./routes/test-app.ts";
import { browser, field, sleep } from "./test-browser.ts";
import { type RunningServer, startServer } from "./wiring.ts";

let server: RunningServer;
let base: string;
let pages: string;
const logs: object[] = [];

beforeAll(async () => {
  const port = await freePort();
  const config = loadConfig({ REPOWIKI_MODE: "demo", PORT: String(port) });
  server = await startServer(config, { log: (line) => logs.push(line) });
  // One port, two hosts (ADR-0012): the app on 127.0.0.1, public pages on localhost.
  base = config.appOrigin;
  pages = config.publicOrigin;
  expect(server.urls).toEqual([base]);
}, 60_000);
afterAll(async () => server.close());

describe("the hosted journey in demo mode (spec 2 §11, §13)", () => {
  it("signs in, generates, reviews, previews, publishes, reads signed out, and unpublishes", async () => {
    const me = browser(base);
    expect((await me.go("/")).status).toBe(200);
    const dashboard = await me.follow("/auth/github");
    expect(dashboard.status, JSON.stringify(logs.slice(-5))).toBe(200);
    expect(dashboard.text).toContain("demo-dev/demo-repo");
    const csrf = field(dashboard.text, "csrf");
    const created = await me.go("/projects", {
      form: { csrf, githubRepoId: field(dashboard.text, "githubRepoId") },
    });
    expect(created.status, created.text).toBe(303);
    const projectPath = created.location ?? "";
    expect(projectPath).toMatch(/^\/projects\/[0-9a-f-]{36}$/);

    // The fixture worker runs as a child process and reports back over HTTP.
    let page = await me.go(projectPath);
    for (let i = 0; i < 120 && !page.text.includes("<h2>Revision 1</h2>"); i++) {
      await sleep(500);
      page = await me.go(projectPath);
    }
    expect(page.text, JSON.stringify(logs.filter((l) => "worker" in l))).toContain(
      "<h2>Revision 1</h2>",
    );

    // Every wiki page is public (ADR-0012): there is nothing to hide.
    expect(page.text).not.toContain('name="hidden"');
    const features = FIXTURE_FEATURES;
    expect(features.length).toBeGreaterThan(1);
    // The author edits nothing (ADR-0012): review the generated revision, preview, publish.
    expect(page.text).not.toContain("<textarea");
    const reviewed = await me.go(`${projectPath}/review`, {
      form: { csrf, revision: "1", attest: "yes" },
    });
    expect(reviewed.status, reviewed.text).toBe(303);
    const previewed = await me.go(`${projectPath}/preview`, { form: { csrf, revision: "1" } });
    expect(previewed.status, previewed.text).toBe(303);
    // A build past the request's wait finishes in the background; the page reloads until it is.
    page = await me.reloadUntil(projectPath, (text) => text.includes('name="previewHash"'));
    const previewHash = field(page.text, "previewHash");
    expect(previewHash).toMatch(/^[0-9a-f]{64}$/);
    const id = projectPath.split("/").at(-1) ?? "";
    // The preview opens on the pages origin at an expiring link, never on the app (ADR-0012).
    const opened = await me.go(`${projectPath}/preview/open`, { form: { csrf, revision: "1" } });
    expect(opened.status, opened.text).toBe(303);
    const link = opened.location ?? "";
    expect(link.startsWith(`${pages}/_preview/`)).toBe(true);
    const shown = await browser(pages).go(link);
    expect(shown.status).toBe(200);
    expect(shown.text).toContain("Preview: a private link that expires within an hour");
    expect((await browser(pages).go(`${link}demo-repo/`)).status).toBe(200);
    expect((await me.go(`/preview/${id}/1/`)).status).toBe(404);

    const published = await me.go(`${projectPath}/publish`, {
      form: {
        csrf,
        revision: "1",
        expectedVersion: field(page.text, "expectedVersion"),
        previewHash,
      },
    });
    expect(published.status, published.text).toBe(303);

    const reader = browser(pages);
    // The biography quotes the generated contribution, labelled (ADR-0012, ADR-0013).
    const profile = await reader.go("/demo-dev");
    expect(profile.status).toBe(200);
    expect(profile.text).toContain("The author wrote most of the ingest and search code");
    expect(profile.text).toContain("not written by the author");
    expect(profile.text).toContain('href="/demo-dev/demo-repo/"');
    expect(profile.text).toContain(`href="${base}/"`);
    expect((await reader.go("/demo-dev/demo-repo")).location).toBe("/demo-dev/demo-repo/");
    const wiki = await reader.go("/demo-dev/demo-repo/");
    expect(wiki.status).toBe(200);
    // Search (Pagefind's WebAssembly) and the diagrams need the site's own policy.
    expect(wiki.csp).toContain("'wasm-unsafe-eval'");
    expect((await reader.go("/demo-dev/demo-repo/pagefind/pagefind.js")).status).toBe(200);
    for (const feature of features) {
      expect((await reader.go(`/demo-dev/demo-repo/wiki/${feature}/`)).status).toBe(200);
    }
    // Public pages are not on the app's origin, and the app's session means nothing on theirs.
    expect((await browser(base).go("/demo-dev")).status).toBe(404);
    const signedIn = await me.go(`${pages}/demo-dev`);
    expect(signedIn.status).toBe(200);
    expect(signedIn.text).not.toContain("Sign out");
    expect((await reader.go("/dashboard")).status).toBe(404);

    const withdrawn = await me.go(`${projectPath}/unpublish`, { form: { csrf } });
    expect(withdrawn.status, withdrawn.text).toBe(303);
    expect((await reader.go("/demo-dev/demo-repo/")).status).toBe(410);
    expect((await reader.go("/demo-dev")).status).toBe(404);
  }, 300_000);
});
