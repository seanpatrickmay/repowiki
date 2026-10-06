import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteFormat, siteMarker } from "./site-format.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repowiki-site-format-"));
  mkdirSync(join(root, "src", "pages"), { recursive: true });
  mkdirSync(join(root, "src", "__snapshots__"));
  writeFileSync(join(root, "package.json"), '{"dependencies":{"astro":"7.3.5"}}');
  writeFileSync(join(root, "src", "build.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "pages", "index.astro"), "<p>main</p>\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("siteFormat", () => {
  it("is a stable hash of the site's source files and its package.json", () => {
    const format = siteFormat(root);
    expect(format).toMatch(/^[0-9a-f]{64}$/);
    expect(siteFormat(root)).toBe(format);
  });

  it.each([
    ["a source file changes", () => writeFileSync(join(root, "src", "build.ts"), "export {};\n")],
    ["a page is added", () => writeFileSync(join(root, "src", "pages", "about.astro"), "<p/>")],
    ["a dependency changes", () => writeFileSync(join(root, "package.json"), "{}")],
  ])("changes when %s", (_what, change) => {
    const before = siteFormat(root);
    change();
    expect(siteFormat(root)).not.toBe(before);
  });

  it("ignores the files only tests read", () => {
    const before = siteFormat(root);
    writeFileSync(join(root, "src", "build.test.ts"), "it();\n");
    writeFileSync(join(root, "src", "__snapshots__", "page.html"), "<p/>");
    expect(siteFormat(root)).toBe(before);
  });
});

describe("siteMarker", () => {
  it("records the format a finished build was made with", () => {
    expect(siteMarker("ab12")).toBe('{"format":"ab12"}\n');
    expect(JSON.parse(siteMarker())).toEqual({ format: siteFormat() });
  });
});
