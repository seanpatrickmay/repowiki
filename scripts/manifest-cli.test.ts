import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLedgerEntry, makeManifest } from "@repowiki/core/test-fixtures";
import { GitError, ManifestBuildError, manifestCacheKey, openStore } from "@repowiki/engine";
import { LlmError, LlmOutputError } from "@repowiki/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CliError,
  exitCodeFor,
  loadModels,
  manifestLedgerRows,
  parseManifestArgs,
} from "./manifest-cli.ts";

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
    ["an unknown key", () => write('{"models":{},"extra":1}'), /invalid config .*: .*"extra"/],
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

describe("manifestLedgerRows", () => {
  it("keeps only this sha's manifest calls, whatever the prompt hash", () => {
    const sha = "a".repeat(40);
    const mine = makeLedgerEntry({ purpose: "manifest", cacheKey: manifestCacheKey(sha, "p") });
    const legacy = makeLedgerEntry({ purpose: "manifest", cacheKey: `manifest-${sha}` });
    const otherSha = makeLedgerEntry({
      purpose: "manifest",
      cacheKey: manifestCacheKey("b".repeat(40), "p"),
    });
    const write = makeLedgerEntry({ purpose: "write", cacheKey: manifestCacheKey(sha, "p") });
    const uncached = makeLedgerEntry({ purpose: "write", cacheKey: null });
    expect(manifestLedgerRows([mine, legacy, otherSha, write, uncached], sha)).toEqual([
      mine,
      legacy,
    ]);
  });
});

describe("exitCodeFor", () => {
  it("maps usage errors to 2, build, git and LLM failures to 1, and leaves bugs alone", () => {
    expect(exitCodeFor(new CliError("x"))).toBe(2);
    expect(exitCodeFor(new ManifestBuildError("x"))).toBe(1);
    expect(exitCodeFor(new GitError("x"))).toBe(1);
    expect(exitCodeFor(new LlmError("x"))).toBe(1);
    expect(exitCodeFor(new LlmOutputError("x", "text"))).toBe(1);
    expect(exitCodeFor(new TypeError("x"))).toBeNull();
    expect(exitCodeFor("x")).toBeNull();
  });
});

describe("manifest-build.ts as a process (no network)", () => {
  const run = (...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
    delete env.ANTHROPIC_API_KEY;
    delete env.REPOWIKI_CASSETTE;
    return spawnSync(process.execPath, ["scripts/manifest-build.ts", ...args], {
      encoding: "utf8",
      env,
    });
  };

  /** A one-commit git repository under the scratch dir, isolated from the user's git config. */
  function gitRepo(): string {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.com",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.com",
        },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    return repo;
  }

  it("reuses a stored manifest without an API key", () => {
    const repo = gitRepo();
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(makeManifest({ sha }));
    store.close();
    const result = run(repo, "--out", out);
    expect(result.stderr).toBe(`reusing the stored manifest for ${sha}\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`manifest-${sha.slice(0, 7)}.md`);
  });

  it("reports a missing API key in one line, exit 1, before any call", () => {
    const result = run(gitRepo(), "--out", join(dir, "o"));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("ANTHROPIC_API_KEY is not set; run with node --env-file=.env\n");
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
