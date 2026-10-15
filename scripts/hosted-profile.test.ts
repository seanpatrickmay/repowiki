import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProfileArgs } from "./hosted-profile.ts";

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
