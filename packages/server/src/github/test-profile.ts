import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProfile } from "./profile.ts";

export const ADA_HEAD = "e".repeat(40);
const repo = (id: number, name: string) => ({
  id,
  name,
  full_name: `ada/${name}`,
  owner: { login: "ada" },
  private: false,
  fork: false,
  default_branch: "main",
  size: 40,
  description: `${name}, a made-up project`,
  html_url: `https://github.com/ada/${name}`,
  clone_url: `https://github.com/ada/${name}.git`,
  permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
});

/**
 * Test-only: a made-up user `ada` with `engine` (mapped to `exportPath`, 30 commits) and `empty`
 * (no commits, no head, no export).
 */
export function adaProfile(exportPath: string | null = null): LocalProfile {
  return LocalProfile.parse({
    takenAt: "2026-10-15T00:00:00.000Z",
    user: { id: 7001, login: "ada", name: "Ada Lovelace", created_at: "2015-01-01T00:00:00Z" },
    repos: [
      {
        repo: repo(8001, "engine"),
        commits: 30,
        commitShas: Array.from({ length: 30 }, (_, i) => (i + 1).toString(16).padStart(40, "a")),
        head: ADA_HEAD,
        githubHead: "f".repeat(40),
        export: exportPath,
      },
      {
        repo: repo(8002, "empty"),
        commits: 0,
        commitShas: [],
        head: null,
        githubHead: null,
        export: null,
      },
    ],
  });
}

/** Test-only: `profile` saved to a new temporary file; returns its path. */
export function writeProfile(profile: LocalProfile): string {
  const path = join(mkdtempSync(join(tmpdir(), "repowiki-profile-")), "profile.json");
  writeFileSync(path, JSON.stringify(profile));
  return path;
}
