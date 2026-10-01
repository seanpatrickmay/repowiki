import { spawnSync } from "node:child_process";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Variables that redirect git to a different repository, index or object store. */
const REDIRECTING_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
] as const;

/** The process environment (plus `extra`) without anything that would redirect `git -C <repo>`. */
export function scrubbedGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of REDIRECTING_GIT_ENV) delete env[name];
  return env;
}

/** git never ran to completion; an output overflow gets its own, actionable message. */
function spawnError(error: NodeJS.ErrnoException): GitError {
  if (error.code === "ENOBUFS" || /maxBuffer/i.test(error.message)) {
    return new GitError(
      "the repository's tracked content is too large to index in one pass " +
        "(git output exceeded the 1 GiB read buffer); streaming reads are tracked in issue #74",
    );
  }
  return new GitError(`could not run git: ${error.message}`);
}

/** Runs a read-only git command against `repo`; never touches its working tree or index. */
function git(repo: string, args: readonly string[], input?: string): Buffer {
  const result = spawnSync("git", ["-C", repo, ...args], {
    input,
    maxBuffer: 1 << 30,
    env: scrubbedGitEnv(),
  });
  if (result.error) throw spawnError(result.error);
  if (result.status !== 0) {
    throw new GitError(
      `git ${args[0]} failed in ${repo}: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout;
}

/** Full 40-character sha of the commit `rev` names. */
export function resolveCommit(repo: string, rev: string): string {
  const out = spawnSync(
    "git",
    ["-C", repo, "rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
    { env: scrubbedGitEnv() },
  );
  if (out.error) throw spawnError(out.error);
  const sha = out.stdout?.toString("utf8").trim() ?? "";
  if (out.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new GitError(`${repo}: "${rev}" does not name a commit`);
  }
  return sha;
}

export interface TreeBlob {
  path: string;
  oid: string;
  size: number;
}

/** Regular files at `sha`. Symlinks and submodules are skipped: they have no indexable source. */
export function listBlobs(repo: string, sha: string): TreeBlob[] {
  const out = git(repo, ["ls-tree", "-r", "-z", "--long", "--full-tree", sha]).toString("utf8");
  const blobs: TreeBlob[] = [];
  for (const entry of out.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    const [mode, type, oid, size] = entry.slice(0, tab).split(/ +/);
    if (type !== "blob" || mode === "120000" || oid === undefined || size === undefined) continue;
    blobs.push({ path: entry.slice(tab + 1), oid, size: Number(size) });
  }
  return blobs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Contents of the given blobs, keyed by object id. */
export function readBlobs(repo: string, oids: readonly string[]): Map<string, Buffer> {
  const unique = [...new Set(oids)];
  const blobs = new Map<string, Buffer>();
  if (unique.length === 0) return blobs;
  const out = git(repo, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  let offset = 0;
  while (offset < out.length) {
    const headerEnd = out.indexOf(0x0a, offset);
    const [oid, type, size] = out.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (oid === undefined || type !== "blob" || size === undefined) {
      throw new GitError(
        `unexpected cat-file header: ${out.subarray(offset, headerEnd).toString("utf8")}`,
      );
    }
    const start = headerEnd + 1;
    blobs.set(oid, out.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return blobs;
}

/** Files changed by each non-merge commit reachable from `sha`, newest first. Renames count as delete + add. */
export function commitFiles(repo: string, sha: string): string[][] {
  const out = git(repo, [
    "log",
    "--no-merges",
    "--no-renames",
    "-z",
    "--name-only",
    "--format=%x00%H",
    sha,
  ]);
  const tokens = out.toString("utf8").split("\0");
  const commits: string[][] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    // Commit marker: empty token followed by 40-char hex SHA
    if (token === "" && i + 1 < tokens.length) {
      const nextToken = tokens[i + 1];
      if (nextToken && /^[0-9a-f]{40}$/.test(nextToken)) {
        i += 2; // Skip empty token and SHA
        const paths: string[] = [];
        let isFirstPath = true;

        // Collect paths until next empty token
        while (i < tokens.length) {
          const path = tokens[i];
          if (!path || path === "") break;

          let finalPath = path;
          // Strip leading \n (format terminator) from first path only
          if (isFirstPath && path.startsWith("\n")) {
            finalPath = path.slice(1);
          }
          isFirstPath = false;

          // Only add non-empty paths
          if (finalPath !== "") {
            paths.push(finalPath);
          }
          i++;
        }

        commits.push(paths);
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return commits;
}
