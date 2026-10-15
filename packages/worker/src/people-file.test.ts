import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PeopleConfig, parsePeopleConfig } from "@repowiki/core";
import { openStore, readPeople } from "@repowiki/engine";
import { createTestRepo } from "@repowiki/engine/test-repo";
import { describe, expect, it } from "vitest";
import { AUTHOR_ID, authorEmails, peopleFile } from "./people-file.ts";

/**
 * A fake git that prints the emails of the shas it knows, as `git log --no-walk` would, and
 * writes its environment to `env` beside itself.
 */
function fakeGit(known: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-git-"));
  const path = join(dir, "git");
  const table = Object.entries(known)
    .map(([sha, email]) => `${sha}) echo '${email}' ;;`)
    .join("\n    ");
  writeFileSync(
    path,
    `#!/bin/sh\nenv > '${dir}/env'\nfor arg in "$@"; do\n  case "$arg" in\n    ${table}\n  esac\ndone\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const HOME = mkdtempSync(join(tmpdir(), "home-"));

/** A local bare repository with one commit by `email`; git reads only the disk. */
function bareRepo(email: string): { repo: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "people-repo-"));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => execFileSync("git", args, { env, encoding: "utf8" }).trim();
  git("init", "-q", join(dir, "src"));
  git(
    "-C",
    join(dir, "src"),
    "-c",
    `user.email=${email}`,
    "-c",
    "user.name=Dev",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "one",
  );
  git("clone", "-q", "--bare", join(dir, "src"), join(dir, "repo.git"));
  return {
    repo: join(dir, "repo.git"),
    sha: git("-C", join(dir, "repo.git"), "rev-parse", "HEAD"),
  };
}

describe("the people file (spec 2 §8)", () => {
  it("collects the distinct, lowercased emails of the author's commits and skips unknown shas", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const git = fakeGit({ [a]: "Dev@Example.com", [b]: "dev@example.com" });
    expect(authorEmails("/repo.git", [a, b, "c".repeat(40)], HOME, git)).toEqual([
      "dev@example.com",
    ]);
    expect(authorEmails("/repo.git", [], HOME, git)).toEqual([]);
  });

  it("runs git with the work dir's home and no user or system configuration", () => {
    const a = "a".repeat(40);
    const git = fakeGit({ [a]: "dev@example.com" });
    authorEmails("/repo.git", [a], HOME, git);
    const env = readFileSync(join(dirname(git), "env"), "utf8");
    for (const line of [
      `HOME=${HOME}`,
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_TERMINAL_PROMPT=0",
    ])
      expect(env.split("\n")).toContain(line);
    expect(env).not.toMatch(/REPOWIKI_|ANTHROPIC_/);
  });

  it("drops values that are not email addresses, and shared placeholder addresses", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const c = "c".repeat(40);
    expect(authorEmails("/repo.git", [a], HOME, fakeGit({ [a]: "not an email" }))).toEqual([]);
    const git = fakeGit({ [a]: "noreply@github.com", [b]: "no-reply@example.com", [c]: "d@e.io" });
    expect(authorEmails("/repo.git", [a, b, c], HOME, git)).toEqual(["d@e.io"]);
  });

  it("reads a real clone, and a clone that lacks every listed sha gives no email (never HEAD's)", () => {
    const { repo, sha } = bareRepo("Dev@Example.com");
    expect(authorEmails(repo, [sha, "c".repeat(40)], HOME)).toEqual(["dev@example.com"]);
    expect(authorEmails(repo, ["c".repeat(40), "d".repeat(40)], HOME)).toEqual([]);
  });

  it("writes one person matched by login and email, with no owner, narrative or commit floor", () => {
    const file = peopleFile("Demo-Dev", ["dev@example.com"]);
    expect(file).toEqual({
      people: [
        { id: AUTHOR_ID, match: ["login:demo-dev", "email:dev@example.com"], narrative: false },
      ],
      owner: [],
      minCommits: 1,
      ignoreRevs: false,
      mailmap: false,
    });
    expect(parsePeopleConfig(file).problems).toEqual([]);
  });

  it("keeps a committed .mailmap or ignore list from giving the author anyone else's commits", () => {
    const repo = createTestRepo();
    const store = openStore(":memory:");
    try {
      repo.write("a.txt", "a\n");
      repo.commit("one", "+0000", { name: "Me", email: "me@x.example" });
      repo.write("b.txt", "b\n");
      const alice = repo.commit("two", "+0000", { name: "Alice", email: "alice@y.example" });
      repo.write(".mailmap", "Me <me@x.example> <alice@y.example>\n");
      repo.write(".git-blame-ignore-revs", `${alice}\n`);
      const head = repo.commit("three", "+0000", { name: "Me", email: "me@x.example" });
      const config = PeopleConfig.parse(peopleFile("me", ["me@x.example"]));
      const read = readPeople({ repo: repo.dir, sha: head, store, config, ownerEmail: null });
      const author = read.identities.groups.find((g) => g.entry === 0);
      expect(author?.identities.map((i) => i.email)).toEqual(["me@x.example"]);
      expect(author?.commits).toBe(2);
      expect(read.ignoreRevs).toEqual([]);
    } finally {
      store.close();
      repo.remove();
    }
  });
});
