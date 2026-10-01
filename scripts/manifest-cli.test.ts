import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, ManifestBuildError } from "@repowiki/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError, exitCodeFor, loadModels, parseManifestArgs } from "./manifest-cli.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "repowiki-cli-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseManifestArgs", () => {
  it("reads the repo, the rev and the flags in any order", () => {
    expect(
      parseManifestArgs(["--out", "o", "r", "abc", "--config", "c.json", "--no-batch"]),
    ).toEqual({ repo: "r", rev: "abc", out: "o", config: "c.json", batch: false });
    expect(parseManifestArgs(["r"])).toEqual({
      repo: "r",
      rev: "HEAD",
      out: null,
      config: null,
      batch: true,
    });
  });

  it.each([
    ["no repo", []],
    ["an unknown flag", ["r", "--nope"]],
    ["a flag without its value", ["r", "--out"]],
    ["a third positional", ["r", "HEAD", "extra"]],
  ])("throws a one-line CliError for %s", (_name, argv) => {
    const error = (() => {
      try {
        parseManifestArgs(argv);
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("usage: pnpm manifest:build");
    expect((error as CliError).message).not.toContain("\n");
  });
});

describe("loadModels", () => {
  it("uses the defaults without a file and applies a file's overrides", () => {
    expect(loadModels(null).manifest).toBe("claude-haiku-4-5");
    const file = join(dir, "c.json");
    writeFileSync(file, '{"models":{"manifest":"claude-sonnet-5-5"}}');
    expect(loadModels(file).manifest).toBe("claude-sonnet-5-5");
  });

  it.each([
    ["a missing file", () => join(dir, "missing.json"), /cannot read config .*missing\.json/],
    ["invalid JSON", () => write("{nope"), /not valid JSON/],
    [
      "an unknown key",
      () => write('{"models":{},"extra":1}'),
      /invalid config .*extra|invalid config/,
    ],
    [
      "an empty model id",
      () => write('{"models":{"manifest":""}}'),
      /invalid config .*models\.manifest/,
    ],
  ])("throws a one-line CliError for %s", (_name, path, pattern) => {
    const file = path();
    const error = (() => {
      try {
        loadModels(file);
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(pattern);
    expect((error as CliError).message).not.toContain("\n");
  });

  function write(text: string): string {
    const file = join(dir, "bad.json");
    writeFileSync(file, text);
    return file;
  }
});

describe("exitCodeFor", () => {
  it("maps usage errors to 2, build and git failures to 1, and leaves bugs alone", () => {
    expect(exitCodeFor(new CliError("x"))).toBe(2);
    expect(exitCodeFor(new ManifestBuildError("x"))).toBe(1);
    expect(exitCodeFor(new GitError("x"))).toBe(1);
    expect(exitCodeFor(new TypeError("x"))).toBeNull();
    expect(exitCodeFor("x")).toBeNull();
  });
});

describe("manifest-build.ts as a process (no network)", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/manifest-build.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: dir },
    });

  it("prints one line and exits 2 for a bad flag", () => {
    const result = run("r", "--nope");
    expect(result.status).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toBe("");
  });

  it("reports a nonexistent repository before looking at --out", () => {
    const missing = join(dir, "nope");
    const result = run(missing);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(`no such repository: ${missing}\n`);
  });

  it("reports a bad --config file in one line", () => {
    mkdirSync(join(dir, "repo"));
    const result = run(
      join(dir, "repo"),
      "--config",
      join(dir, "missing.json"),
      "--out",
      join(dir, "o"),
    );
    expect(result.status).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/^cannot read config /);
  });
});
