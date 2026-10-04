import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scrubbedGitEnv } from "./git.ts";

/** A throwaway git repository with scripted, deterministic commits. Test-only. */
export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  write(path: string, content: string | Buffer): void;
  /** Stages everything and commits; returns the new sha. Dates advance one day per commit, in `tz`. */
  commit(message: string, tz?: string): string;
  remove(): void;
}

// Isolate from the developer's git config (signing, hooks, default branch, identity).
const ISOLATED_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

export function createTestRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-index-"));
  let day = 0;
  const run = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync("git", args, {
      cwd: dir,
      env: scrubbedGitEnv({ ...ISOLATED_ENV, ...env }),
      encoding: "utf8",
    }).trim();
  run(["init", "-q", "-b", "main"]);
  return {
    dir,
    git: (...args) => run(args),
    write(path, content) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    commit(message, tz = "+0000") {
      day++;
      const date = `@${1_767_225_600 + day * 86_400} ${tz}`;
      run(["add", "-A"]);
      run(["commit", "-q", "--allow-empty", "--allow-empty-message", "-m", message], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
      return run(["rev-parse", "HEAD"]);
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
