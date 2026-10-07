import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, type TestRepo } from "../index/index.ts";
import {
  parseGitHubFlag,
  parseGitHubRemote,
  readOriginUrl,
  resolveGitHubIdentity,
} from "./identity.ts";

describe("parseGitHubRemote (R24)", () => {
  it.each([
    ["https://github.com/acme/demo", "acme", "demo"],
    ["https://github.com/acme/demo.git", "acme", "demo"],
    ["https://github.com/acme/demo/", "acme", "demo"],
    ["git@github.com:NU-NExT/next-chief-of-staff.git", "NU-NExT", "next-chief-of-staff"],
    ["ssh://git@github.com/seanpatrickmay/repowiki.git", "seanpatrickmay", "repowiki"],
    ["https://GitHub.com/a/b.c_d-e", "a", "b.c_d-e"],
  ])("reads %s", (url, owner, name) => {
    expect(parseGitHubRemote(url)).toEqual({ owner, name });
  });

  it.each([
    "https://gitlab.com/acme/demo.git",
    "https://github.com.evil.example/acme/demo",
    "http://github.com/acme/demo",
    "git@gh-work:acme/demo.git",
    "ext::sh -c touch% /tmp/pwned",
    "https://github.com/acme",
    "https://github.com/acme/demo/extra",
    "https://github.com/ac%20me/demo",
    "https://github.com/acme/..",
    "https://user:token@github.com/acme/demo.git",
    "/local/path/demo",
  ])("refuses %s", (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });
});

describe("parseGitHubFlag", () => {
  it("takes owner/name and nothing else", () => {
    expect(parseGitHubFlag("acme/demo")).toEqual({ owner: "acme", name: "demo" });
    for (const bad of ["acme", "acme/demo/x", "/demo", "acme/", "ac me/demo", "acme/.", "a@b/c"])
      expect(parseGitHubFlag(bad), bad).toBeNull();
  });
});

describe("resolveGitHubIdentity", () => {
  let repo: TestRepo;
  beforeEach(() => {
    repo = createTestRepo();
    repo.write("a.txt", "a\n");
    repo.commit("init");
  });
  afterEach(() => repo.remove());

  it("prefers --github, else reads origin's URL without running or fetching it", () => {
    expect(resolveGitHubIdentity(repo.dir, "acme/demo")).toEqual({
      identity: { owner: "acme", name: "demo" },
    });
    repo.git("remote", "add", "origin", "git@github.com:acme/demo.git");
    expect(readOriginUrl(repo.dir)).toBe("git@github.com:acme/demo.git");
    expect(resolveGitHubIdentity(repo.dir, null)).toEqual({
      identity: { owner: "acme", name: "demo" },
    });
  });

  it("reads the URL git itself fetches from when origin has several", () => {
    repo.git("remote", "add", "origin", "https://github.com/acme/first.git");
    repo.git("config", "--add", "remote.origin.url", "https://github.com/evil/second.git");
    expect(readOriginUrl(repo.dir)).toBe("https://github.com/acme/first.git");
    expect(resolveGitHubIdentity(repo.dir, null)).toEqual({
      identity: { owner: "acme", name: "first" },
    });
  });

  it("says git found the repository unsafe rather than that it has no origin", () => {
    const bin = join(repo.dir, "..", `fake-git-${process.pid}`);
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\necho "fatal: detected dubious ownership in repository at '${repo.dir}'" >&2\nexit 128\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved ?? ""}`;
    try {
      const skip = resolveGitHubIdentity(repo.dir, null);
      expect("skip" in skip && skip.skip).toMatch(/^git treats the repository as unsafe/);
    } finally {
      process.env.PATH = saved;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("skips with a hint when there is no origin, or origin is not on github.com", () => {
    expect(resolveGitHubIdentity(repo.dir, null)).toEqual({
      skip: "the repository has no origin remote; pass --github owner/name",
    });
    repo.git("remote", "add", "origin", "https://gitlab.com/acme/demo.git");
    expect(resolveGitHubIdentity(repo.dir, null)).toEqual({
      skip: "the origin remote is not a github.com repository; pass --github owner/name",
    });
    expect(resolveGitHubIdentity(repo.dir, "not a repo")).toEqual({
      skip: "--github must be owner/name, as GitHub spells them",
    });
  });
});
