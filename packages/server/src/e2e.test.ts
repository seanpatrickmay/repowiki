import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { freePort } from "./routes/test-app.ts";
import { browser, field, sleep } from "./test-browser.ts";
import { type RunningServer, startServer } from "./wiring.ts";

let server: RunningServer;
let base: string;
const logs: object[] = [];

beforeAll(async () => {
  const port = await freePort();
  const config = loadConfig({ REPOWIKI_MODE: "demo", PORT: String(port) });
  server = await startServer(config, { log: (line) => logs.push(line) });
  base = server.urls[0] ?? "";
}, 60_000);
afterAll(async () => server.close());

describe("the hosted journey in demo mode (spec 2 §11, §13)", () => {
  it("signs in, generates, edits, reviews, previews, publishes, reads signed out, and unpublishes", async () => {
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
    for (let i = 0; i < 120 && !page.text.includes("Portfolio (revision 1)"); i++) {
      await sleep(500);
      page = await me.go(projectPath);
    }
    expect(page.text, JSON.stringify(logs.filter((l) => "worker" in l))).toContain(
      "Portfolio (revision 1)",
    );

    // Every wiki page is public (ADR-0012): there is nothing to hide.
    expect(page.text).not.toContain('name="hidden"');
    const features = [...page.text.matchAll(/name="highlight" value="([^"]+)"/g)].map((m) => m[1]);
    expect(features.length).toBeGreaterThan(1);
    const saved = await me.go(`${projectPath}/revisions`, {
      form: {
        csrf,
        baseRevision: "1",
        tagline: field(page.text, "tagline"),
        summary: "A small project the demo documents.",
        contribution: "I wrote the ingest code.",
      },
    });
    expect(saved.status, saved.text).toBe(303);
    const reviewed = await me.go(`${projectPath}/review`, {
      form: { csrf, revision: "2", attest: "yes" },
    });
    expect(reviewed.status, reviewed.text).toBe(303);
    const previewed = await me.go(`${projectPath}/preview`, { form: { csrf, revision: "2" } });
    expect(previewed.status, previewed.text).toBe(303);
    page = await me.go(projectPath);
    const previewHash = field(page.text, "previewHash");
    expect(previewHash).toMatch(/^[0-9a-f]{64}$/);
    const id = projectPath.split("/").at(-1) ?? "";
    expect((await me.go(`/preview/${id}/2/`)).status).toBe(200);
    expect((await browser(base).go(`/preview/${id}/2/`)).status).toBe(404);

    const published = await me.go(`${projectPath}/publish`, {
      form: {
        csrf,
        revision: "2",
        expectedVersion: field(page.text, "expectedVersion"),
        previewHash,
      },
    });
    expect(published.status, published.text).toBe(303);

    const reader = browser(base);
    const project = await reader.go("/demo-dev/demo-repo");
    expect(project.status).toBe(200);
    expect(project.text).toContain("I wrote the ingest code.");
    const wiki = await reader.go("/demo-dev/demo-repo/docs/");
    expect(wiki.status).toBe(200);
    // Search (Pagefind's WebAssembly) and the diagrams need the site's own policy.
    expect(wiki.csp).toContain("'wasm-unsafe-eval'");
    expect((await reader.go("/demo-dev/demo-repo/docs/pagefind/pagefind.js")).status).toBe(200);
    for (const feature of features) {
      expect((await reader.go(`/demo-dev/demo-repo/docs/wiki/${feature}/`)).status).toBe(200);
    }
    const profile = await reader.go("/demo-dev");
    expect(profile.status).toBe(200);
    expect(profile.text).toContain('href="/demo-dev/demo-repo"');

    const withdrawn = await me.go(`${projectPath}/unpublish`, { form: { csrf } });
    expect(withdrawn.status, withdrawn.text).toBe(303);
    expect((await reader.go("/demo-dev/demo-repo")).status).toBe(410);
    expect((await reader.go("/demo-dev/demo-repo/docs/")).status).toBe(410);
  }, 300_000);
});
