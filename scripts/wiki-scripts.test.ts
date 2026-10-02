import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeManifest, makeRevision, SHA_A } from "@repowiki/core/test-fixtures";
import { openStore } from "@repowiki/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_LOCK } from "./wiki-cli.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "repowiki-wiki-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs a script with no API key and HOME in the scratch dir; nothing reaches the network. */
function run(script: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
  delete env.ANTHROPIC_API_KEY;
  delete env.REPOWIKI_CASSETTE;
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
}

/** A one-commit git repository under the scratch dir, and its sha. */
function gitRepo(): { repo: string; sha: string } {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
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
  return { repo, sha: git("rev-parse", "HEAD").trim() };
}

describe("wiki-build.ts as a process (no network)", () => {
  /** A repo whose store holds a manifest at its head, so the build reaches its first call. */
  function storedRepo() {
    const { repo, sha } = gitRepo();
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(makeManifest({ sha }), { llmRevised: true });
    store.close();
    return { repo, out };
  }

  it("names the pnpm command and --env-file when the key is missing, and frees its lock", () => {
    const { repo, out } = storedRepo();
    const result = run("scripts/wiki-build.ts", repo, "--out", out);
    expect(result.status).toBe(1);
    const last = result.stderr.trimEnd().split("\n").at(-1) ?? "";
    expect(last).toContain("ANTHROPIC_API_KEY is not set");
    expect(last).toContain("pnpm wiki:build");
    expect(last).toContain("--env-file");
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
  });

  it("refuses to start while another build holds the lock, before any work", () => {
    const { repo, out } = storedRepo();
    writeFileSync(join(out, BUILD_LOCK), "pid 1 since 2026-10-01T00:00:00.000Z\n");
    const result = run("scripts/wiki-build.ts", repo, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `another wiki:build is running on ${out} (${join(out, BUILD_LOCK)}); if none is, delete the lock file\n`,
    );
    expect(existsSync(join(out, BUILD_LOCK))).toBe(true);
  });
});

describe("wiki-check.ts as a process (no network)", () => {
  /** A store under `out` holding one page and the head, both at SHA_A. */
  function builtStore(): string {
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(makeManifest(), { llmRevised: true });
    store.putRevision(makeRevision());
    store.setHead(SHA_A);
    store.close();
    return out;
  }

  it("is a one-line usage error, exit 2, for a repository that does not exist", () => {
    const out = builtStore();
    const missing = join(dir, "nope");
    const result = run("scripts/wiki-check.ts", missing, "--out", out);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      `no such repository: ${missing}; usage: pnpm wiki:check <repo-path> [--out dir]\n`,
    );
  });

  it("is a one-line usage error, exit 2, for a repository without the wiki's sha", () => {
    const out = builtStore();
    const { repo } = gitRepo();
    const result = run("scripts/wiki-check.ts", repo, "--out", out);
    expect(result.status).toBe(2);
    expect(result.stderr.split("\n")).toHaveLength(2);
    expect(result.stderr).toMatch(
      new RegExp(`^${repo} does not hold ${SHA_A}, the sha the wiki was built at`),
    );
  });
});
