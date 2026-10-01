import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureExport } from "./test-fixtures.ts";
import { type BuiltSite, brokenLinks, buildFixtureSite, htmlFiles, runCli } from "./test-site.ts";

let site: BuiltSite;
beforeAll(() => {
  site = buildFixtureSite(["--repo-url", "https://github.com/acme/demo-repo"]);
}, 120_000);
afterAll(() => site.cleanup());

describe("site build", () => {
  it("renders the Main Page and a Pagefind index", () => {
    expect(site.read("index.html")).toContain("Welcome to the demo-repo wiki");
    expect(existsSync(join(site.outDir, "pagefind", "pagefind.js"))).toBe(true);
    expect(site.stdout).toMatch(/^built .+ \(\d+ HTML pages\)$/m);
  });

  it("has no same-site links to missing pages or anchors", () => {
    expect(htmlFiles(site.outDir).length).toBeGreaterThan(0);
    expect(brokenLinks(site.outDir)).toEqual([]);
  });

  it("references no off-site scripts, styles or fonts", () => {
    for (const page of htmlFiles(site.outDir)) {
      expect(site.read(page)).not.toMatch(
        /(?:src|href)="(?:https?:)?\/\/[^"]*\.(?:js|css|woff2?)"/,
      );
    }
  });
});

describe("site build input validation", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "repowiki-site-bad-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fails loudly on an export that violates the schema, and writes nothing", () => {
    const bad = { ...fixtureExport(), head: "not-a-sha" };
    writeFileSync(join(dir, "export.json"), JSON.stringify(bad));
    const result = runCli(["build", "--export", dir, "--out", join(dir, "out")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`invalid export ${join(dir, "export.json")}`);
    expect(result.stderr).toContain("head");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("fails loudly on a missing export", () => {
    const result = runCli(["build", "--export", join(dir, "missing.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read export");
  });

  it("exits 2 with usage on bad arguments", () => {
    const result = runCli(["build"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--export is required");
  });
});
