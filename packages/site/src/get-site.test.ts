import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getSite } from "./site.ts";
import { fixtureExport } from "./test-fixtures.ts";

const ENV_KEYS = ["REPOWIKI_BUILD", "REPOWIKI_EXPORT", "REPOWIKI_REPO_URL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let dir: string;
let exportFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "repowiki-get-site-"));
  exportFile = join(dir, "export.json");
  writeFileSync(exportFile, JSON.stringify(fixtureExport()));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("getSite", () => {
  it.each([
    "https://x-access-token:ghp_SECRET@github.com/acme/r",
    "https://github.com/acme/r?x=1",
    "https://github.com/acme/r#frag",
    "javascript:alert(1)",
  ])("validates REPOWIKI_REPO_URL like --repo-url: %j", (url) => {
    process.env.REPOWIKI_BUILD = `bad-url ${url}`;
    process.env.REPOWIKI_EXPORT = exportFile;
    process.env.REPOWIKI_REPO_URL = url;
    expect(() => getSite()).toThrow(/^REPOWIKI_REPO_URL /);
    try {
      getSite();
    } catch (error) {
      expect((error as Error).message).not.toContain("ghp_SECRET");
    }
  });

  it("loads once per build token and reloads for a new one, even from the same path", () => {
    process.env.REPOWIKI_EXPORT = exportFile;
    process.env.REPOWIKI_REPO_URL = "";
    process.env.REPOWIKI_BUILD = "build-1";
    const first = getSite();
    expect(getSite()).toBe(first);
    expect(first.wiki.repo).toBe("demo-repo");

    writeFileSync(exportFile, JSON.stringify({ ...fixtureExport(), repo: "second-repo" }));
    expect(getSite()).toBe(first);
    process.env.REPOWIKI_BUILD = "build-2";
    expect(getSite().wiki.repo).toBe("second-repo");
  });
});
