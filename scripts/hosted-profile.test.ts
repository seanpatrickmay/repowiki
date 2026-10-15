import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, WikiExport } from "@repowiki/core";
import { makeManifest, makePeopleSnapshot, SHA_A } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { parseProfileArgs, repoLine } from "./hosted-profile.ts";

const HOME = "/home/ada";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parse = (argv: string[]) => parseProfileArgs(argv, { home: HOME, repoRoot: REPO });

describe("pnpm hosted:profile arguments", () => {
  it("needs a login and defaults the output and exports under ~/.repowiki", () => {
    expect(parse(["ada"])).toEqual({
      login: "ada",
      out: join(HOME, ".repowiki", "hosted-local", "ada.json"),
      exports: join(HOME, ".repowiki"),
    });
    expect(() => parse([])).toThrow(/usage/);
    expect(() => parse(["ada", "bob"])).toThrow(/usage/);
    expect(() => parse(["not a login"])).toThrow(/login/);
  });

  it("takes --out and --exports", () => {
    expect(parse(["ada", "--out", "/tmp/a.json", "--exports", "/tmp/wikis"])).toEqual({
      login: "ada",
      out: "/tmp/a.json",
      exports: "/tmp/wikis",
    });
    expect(() => parse(["ada", "--bogus"])).toThrow(/usage/);
  });

  it("refuses an --out inside the repository", () => {
    expect(() => parse(["ada", "--out", join(REPO, "ada.json")])).toThrow(/inside/);
    expect(() => parse(["ada", "--out", join(REPO, "docs", "x", "ada.json")])).toThrow(/inside/);
  });
});

describe("pnpm hosted:profile output", () => {
  it("names each repository's export and whose People numbers will be shown", () => {
    const exp = WikiExport.parse({
      schemaVersion: SCHEMA_VERSION,
      repo: "engine",
      head: SHA_A,
      exportedAt: "2026-10-15T00:00:00Z",
      manifest: makeManifest(),
      pages: [],
      history: {},
      people: { snapshot: makePeopleSnapshot(), pages: [] },
    });
    const path = join(mkdtempSync(join(tmpdir(), "hosted-profile-")), "export.json");
    writeFileSync(path, JSON.stringify(exp));
    const entry = { repo: { name: "engine" }, commits: 30, export: path, head: exp.head };
    const line = (name: string | null, more = {}) =>
      repoLine({ ...entry, githubHead: exp.head, ...more }, { login: "ada", name });
    expect(line("Ada Lovelace")).toBe(`engine  30  ${path}  author: ada-lovelace`);
    expect(line(null, { githubHead: "f".repeat(40) })).toBe(
      `engine  30  ${path}  author: ada-lovelace  (export behind GitHub)`,
    );
    expect(repoLine({ ...entry, githubHead: null }, { login: "zed", name: "Zed" })).toContain(
      "author: none (People does not name zed or Zed)",
    );
    expect(
      repoLine({ ...entry, export: null, githubHead: null }, { login: "ada", name: null }),
    ).toBe("engine  30  none");
  });
});
