import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseIndexArgs } from "./index-args.ts";

describe("parseIndexArgs", () => {
  it.each([
    [["r"], { repo: "r", rev: "HEAD", out: null }],
    [["r", "abc123"], { repo: "r", rev: "abc123", out: null }],
    [["r", "--out", "f.json"], { repo: "r", rev: "HEAD", out: "f.json" }],
    [["r", "abc123", "--out", "f.json"], { repo: "r", rev: "abc123", out: "f.json" }],
    [["--out", "f.json", "r", "abc123"], { repo: "r", rev: "abc123", out: "f.json" }],
    [["r", "--out", "f.json", "abc123"], { repo: "r", rev: "abc123", out: "f.json" }],
  ])("parses %j", (argv, expected) => {
    expect(parseIndexArgs(argv)).toEqual(expected);
  });

  it.each([
    ["no arguments", []],
    ["a trailing --out with no value", ["r", "--out"]],
    ["a trailing --out after a rev", ["r", "HEAD", "--out"]],
    ["only a flag", ["--out", "f.json"]],
    ["an unknown flag", ["r", "--nope"]],
    ["too many positionals", ["r", "HEAD", "extra"]],
  ])("returns null for %s", (_name, argv) => {
    expect(parseIndexArgs(argv)).toBeNull();
  });
});

describe("index-repo script", () => {
  it("prints usage and exits 2 for a trailing --out with no value", () => {
    const script = fileURLToPath(new URL("./index-repo.ts", import.meta.url));
    const result = spawnSync(process.execPath, [script, ".", "--out"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
    expect(result.stdout).toBe("");
  });
});
