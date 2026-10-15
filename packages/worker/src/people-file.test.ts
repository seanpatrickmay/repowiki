import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePeopleConfig } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import { AUTHOR_ID, authorEmails, peopleFile } from "./people-file.ts";

/** A fake git that prints the emails of the shas it knows, as `git log --no-walk` would. */
function fakeGit(known: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-git-"));
  const path = join(dir, "git");
  const table = Object.entries(known)
    .map(([sha, email]) => `${sha}) echo '${email}' ;;`)
    .join("\n    ");
  writeFileSync(
    path,
    `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n    ${table}\n  esac\ndone\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

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
    expect(authorEmails("/repo.git", [a, b, "c".repeat(40)], git)).toEqual(["dev@example.com"]);
    expect(authorEmails("/repo.git", [], git)).toEqual([]);
  });

  it("drops values that are not email addresses", () => {
    const a = "a".repeat(40);
    expect(authorEmails("/repo.git", [a], fakeGit({ [a]: "not an email" }))).toEqual([]);
  });

  it("reads a real clone, and a clone that lacks every listed sha gives no email (never HEAD's)", () => {
    const { repo, sha } = bareRepo("Dev@Example.com");
    expect(authorEmails(repo, [sha, "c".repeat(40)])).toEqual(["dev@example.com"]);
    expect(authorEmails(repo, ["c".repeat(40), "d".repeat(40)])).toEqual([]);
  });

  it("writes one person matched by login and email, with no owner, narrative or commit floor", () => {
    const file = peopleFile("Demo-Dev", ["dev@example.com"]);
    expect(file).toEqual({
      people: [
        { id: AUTHOR_ID, match: ["login:demo-dev", "email:dev@example.com"], narrative: false },
      ],
      owner: [],
      minCommits: 1,
    });
    expect(parsePeopleConfig(file).problems).toEqual([]);
  });
});
