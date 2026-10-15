import { spawnSync } from "node:child_process";
import { isPlaceholderEmail } from "@repowiki/engine";

/** The people-file id of the job's author; facts look this person up in the snapshot. */
export const AUTHOR_ID = "author";
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * The distinct author emails of `shas` in the bare clone `repo`, without shared placeholder
 * addresses (a noreply@ address strangers share would claim their commits). A sha the clone lacks
 * (GitHub attributes a commit on a branch the clone does not hold) is skipped, never fatal.
 */
export function authorEmails(repo: string, shas: readonly string[], git = "git"): string[] {
  if (shas.length === 0) return [];
  const out = spawnSync(
    git,
    ["-C", repo, "log", "--no-walk=unsorted", "--ignore-missing", "--format=%ae", ...shas],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const emails = (out.stdout ?? "")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => EMAIL.test(line) && !isPlaceholderEmail(line));
  return [...new Set(emails)];
}

/**
 * The people file for a hosted run (spec 2 §8): the author as one person matched by GitHub login
 * and the emails of the commits GitHub attributes to them; nobody is the owner, nobody gets a
 * narrative, and one commit is enough to be counted. The committed `.mailmap` and
 * `.git-blame-ignore-revs` are the repository's content, not the author's word, so neither is
 * read: either could move another person's commits or lines to the author.
 */
export function peopleFile(login: string, emails: readonly string[]) {
  return {
    people: [
      {
        id: AUTHOR_ID,
        match: [`login:${login.toLowerCase()}`, ...emails.map((email) => `email:${email}`)],
        narrative: false,
      },
    ],
    owner: [] as string[],
    minCommits: 1,
    ignoreRevs: false,
    mailmap: false,
  };
}
