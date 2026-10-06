import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { builtWiki } from "../freshness/index.ts";
import { scrubbedGitEnv, type TestRepo } from "../index/index.ts";
import type { Store } from "../store/index.ts";

const ISOLATED_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Contributor",
  GIT_AUTHOR_EMAIL: "contributor@example.com",
  GIT_COMMITTER_NAME: "Contributor",
  GIT_COMMITTER_EMAIL: "contributor@example.com",
};

/** A pull request's edits: a path to its new text, or null to delete it. */
export type Edits = Readonly<Record<string, string | null>>;

/**
 * builtWiki's repository and store, plus what GitHub would hold for it (spec v2 #9 §9): a bare
 * "remote" cloned from it, and a separate clone that pushes pull-request heads to the remote's
 * `refs/pull/<n>/head`, fork-style, so no branch of the documented repository reaches them.
 * Test-only.
 */
export interface InflightFixture {
  repo: TestRepo;
  store: Store;
  /** The documented repository's first commit, where the wiki is built. */
  first: string;
  /** The remote's file:// URL, fetched with the "file" protocol a test allows. */
  url: string;
  /** An out dir outside the repository. */
  out: string;
  /** Commits `edits` on `base` in the contributor's clone and pushes it as pull request `n`. */
  pushPull(n: number, base: string, edits: Edits, message?: string): string;
  /** Deletes `refs/pull/<n>/head` from the remote, as GitHub does for nothing; tests use it. */
  deletePull(n: number): void;
  remove(): void;
}

/**
 * `onDisk` stores the wiki at `<out>/wiki.db`, for process tests; the fixture's handle is then
 * closed, and `store` must not be used.
 */
export async function inflightFixture(
  options: { onDisk?: boolean } = {},
): Promise<InflightFixture> {
  const root = mkdtempSync(join(tmpdir(), "repowiki-inflight-"));
  const out = join(root, "out");
  mkdirSync(out);
  const { repo, store, first } = await builtWiki(
    options.onDisk === true ? join(out, "wiki.db") : ":memory:",
  );
  if (options.onDisk === true) store.close();
  const run = (cwd: string, args: string[], env: Record<string, string> = {}): string =>
    execFileSync("git", args, {
      cwd,
      env: scrubbedGitEnv({ ...ISOLATED_ENV, ...env }),
      encoding: "utf8",
    }).trim();
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  run(root, ["clone", "--quiet", "--bare", repo.dir, remote]);
  run(root, ["clone", "--quiet", remote, work]);
  let day = 100;
  return {
    repo,
    store,
    first,
    url: `file://${remote}`,
    out,
    pushPull(n, base, edits, message = `pull request ${n}`) {
      run(work, ["fetch", "--quiet", "origin"]);
      run(work, ["checkout", "--quiet", "--detach", base]);
      for (const [path, text] of Object.entries(edits)) {
        const full = join(work, path);
        if (text === null) rmSync(full, { force: true });
        else {
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, text);
        }
      }
      day++;
      const date = `@${1_767_225_600 + day * 86_400} +0000`;
      run(work, ["add", "-A"]);
      run(work, ["commit", "--quiet", "--allow-empty", "-m", message], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
      run(work, ["push", "--quiet", "--force", "origin", `HEAD:refs/pull/${n}/head`]);
      return run(work, ["rev-parse", "HEAD"]);
    },
    deletePull(n) {
      run(remote, ["update-ref", "-d", `refs/pull/${n}/head`]);
    },
    remove() {
      if (options.onDisk !== true) store.close();
      repo.remove();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Every file under a directory with its size and mtime: what "nothing written" is checked by. */
export function listing(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((path) => {
      const stat = statSync(join(dir, path));
      return `${relative(dir, join(dir, path))} ${stat.size} ${stat.mtimeMs}`;
    })
    .sort();
}

/** Every file under a directory with a SHA-256 of its bytes, not its mtime: "byte-identical". */
export function fileHashes(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((path) => statSync(join(dir, path)).isFile())
    .map(
      (path) =>
        `${path} ${createHash("sha256")
          .update(readFileSync(join(dir, path)))
          .digest("hex")}`,
    )
    .sort();
}
