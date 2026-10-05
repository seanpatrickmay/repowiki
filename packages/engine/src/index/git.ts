import { spawn, spawnSync } from "node:child_process";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** git ran past the time its caller gave it and was stopped; still a GitError. */
export class GitTimeoutError extends GitError {}

/** How one git call runs. */
export interface GitOptions {
  /** Stop git after this many milliseconds, with a GitTimeoutError; no limit when absent. */
  timeoutMs?: number;
}

/** The GitTimeoutError for a call that ran past `timeoutMs`, or null for any other failure. */
export function timeoutError(
  error: NodeJS.ErrnoException,
  repo: string,
  args: readonly string[],
  timeoutMs: number | undefined,
): GitTimeoutError | null {
  if (error.code !== "ETIMEDOUT") return null;
  return new GitTimeoutError(
    `git ${args[0]} timed out after ${timeoutMs ?? "?"} ms in ${printable(repo)}`,
  );
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

/** Variables that change how git writes a diff: hunk context, or a tool in place of git's own. */
const DIFF_SHAPING_GIT_ENV = ["GIT_DIFF_OPTS", "GIT_EXTERNAL_DIFF"] as const;

/** Variables that change how git reads every pathspec; the pinned calls give their own rule. */
const PATHSPEC_GIT_ENV = [
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_LITERAL_PATHSPECS",
] as const;

/** Config given through the environment (`git -c` and GIT_CONFIG_COUNT's numbered pairs). */
const CONFIG_INJECTING_GIT_ENV = /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/;

/**
 * The process environment (plus `extra`) without anything that would redirect `git -C <repo>`,
 * reshape its diff output or its pathspecs, or inject config (a hook, an output format) through
 * the environment; and with GIT_NO_LAZY_FETCH=1, so a partial clone's missing object is an error,
 * never a fetch that runs the remote's upload-pack command.
 */
export function scrubbedGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of REDIRECTING_GIT_ENV) delete env[name];
  for (const name of DIFF_SHAPING_GIT_ENV) delete env[name];
  for (const name of PATHSPEC_GIT_ENV) delete env[name];
  for (const name of Object.keys(env)) {
    if (CONFIG_INJECTING_GIT_ENV.test(name)) delete env[name];
  }
  env.GIT_NO_LAZY_FETCH = "1";
  // English messages, whatever the user's locale: the causes below are read from git's own words.
  // LC_ALL and LANGUAGE would override LC_MESSAGES, so they go; the user's character-type locale
  // (what `git grep -i` and -E use on non-ASCII text) stays, with an LC_ALL folded into LC_CTYPE.
  if (env.LC_ALL !== undefined && env.LC_ALL !== "" && env.LC_CTYPE === undefined) {
    env.LC_CTYPE = env.LC_ALL;
  }
  delete env.LC_ALL;
  delete env.LANGUAGE;
  env.LC_MESSAGES = "C";
  return env;
}

/** git never ran to completion; an output overflow gets its own, actionable message. */
function spawnError(error: NodeJS.ErrnoException): GitError {
  if (error.code === "ENOBUFS" || /maxBuffer/i.test(error.message)) {
    return new GitError(
      "the repository's tracked content is too large to index in one pass " +
        "(git output exceeded the 1 GiB read buffer)",
    );
  }
  return new GitError(`could not run git: ${error.message}`);
}

/** One printable line: control and format characters (newlines, escapes, bidi marks) become spaces. */
function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim();
}

/**
 * What git says when the scrubbed environment (no lazy fetch) leaves it without an object
 * (promisor-remote.c): a warning line, then `fatal: could not fetch <oid> from promisor remote`.
 * Anchored to whole lines: git echoes caller text (a pattern, a rev) in other messages.
 */
const PARTIAL_CLONE_STDERR =
  /^warning: lazy fetching disabled; |^fatal: could not fetch [0-9a-f]{40,64} from promisor remote$/m;
/** What git says when it refuses a repository another user owns (setup.c), a line of its own. */
const UNSAFE_REPOSITORY_STDERR = /^fatal: detected dubious ownership in repository at /m;

const PARTIAL_CLONE_CAUSE =
  "a partial clone is missing an object, and RepoWiki reads without fetching missing objects; " +
  "use a full clone or run git fetch --refetch";

function unsafeRepositoryCause(repo: string): string {
  return (
    "git treats the repository as unsafe (owned by another user); RepoWiki ignores safe.directory " +
    "given through the environment, so run git config --global --add safe.directory " +
    `'${printable(repo).replace(/'/g, "'\\''")}'`
  );
}

/**
 * The cause git's stderr names that RepoWiki's own environment brings about (an unsafe repository,
 * a partial clone's missing object), as one printable clause; undefined when it names neither.
 * With `unreadableObject`, a partial clone is named whatever git's stderr says.
 */
export function gitFailureCause(
  repo: string,
  stderr: string,
  options: { unreadableObject?: boolean } = {},
): string | undefined {
  if (UNSAFE_REPOSITORY_STDERR.test(stderr)) return unsafeRepositoryCause(repo);
  if (PARTIAL_CLONE_STDERR.test(stderr)) return PARTIAL_CLONE_CAUSE;
  // `unreadableObject`: the caller knows the failure is a read that went wrong (git grep's exit 1
  // with a message), whatever git's wording; in a partial clone that is a missing blob.
  if (options.unreadableObject === true && isPartialClone(repo)) return PARTIAL_CLONE_CAUSE;
  return undefined;
}

/** True when `repo` is a partial clone: a remote is marked promisor, or extensions.partialClone names one. */
function isPartialClone(repo: string): boolean {
  const config = (...args: string[]) =>
    spawnSync("git", ["-C", repo, "config", ...args], { env: scrubbedGitEnv() });
  const named = config("--get", "extensions.partialClone");
  if (named.status === 0 && (named.stdout?.toString("utf8").trim() ?? "") !== "") return true;
  const promisors = config("--get-regexp", "^remote\\..*\\.promisor$");
  return promisors.status === 0 && /\btrue\s*$/im.test(promisors.stdout?.toString("utf8") ?? "");
}

/**
 * Runs a read-only git command against `repo`; never touches its working tree or index. With
 * `timeoutMs`, a git that runs longer is stopped and reported as a GitTimeoutError.
 */
export function git(repo: string, args: readonly string[], options: GitOptions = {}): Buffer {
  const result = spawnSync("git", ["-C", repo, ...args], {
    maxBuffer: 1 << 30,
    env: scrubbedGitEnv(),
    timeout: options.timeoutMs,
  });
  if (result.error) {
    throw timeoutError(result.error, repo, args, options.timeoutMs) ?? spawnError(result.error);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    const cause = gitFailureCause(repo, stderr);
    throw new GitError(
      cause === undefined
        ? `git ${args[0]} failed in ${repo}: ${stderr}`
        : `git ${args[0]} failed in ${printable(repo)}: ${cause}`,
    );
  }
  return result.stdout;
}

/** A full 40-hex object id (SHA-1 repositories only; SHA-256 ids are 64 hex and are refused). */
export function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Throws unless `sha` is a full 40-hex id, so a ref, range or option never reaches git. */
export function assertSha(sha: string): void {
  if (!isSha(sha)) throw new GitError(`not a 40-hex commit sha: ${JSON.stringify(sha)}`);
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
  if (out.status !== 0 && UNSAFE_REPOSITORY_STDERR.test(out.stderr?.toString("utf8") ?? "")) {
    throw new GitError(`git failed in ${printable(repo)}: ${unsafeRepositoryCause(repo)}`);
  }
  if (out.status !== 0 || !isSha(sha)) {
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
  const out = git(repo, [
    "ls-tree",
    "-r",
    "-z",
    "--long",
    "--full-tree",
    "--end-of-options",
    sha,
  ]).toString("utf8");
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

/** How much of a blob's start is kept to decide whether it is binary. */
export const BINARY_SNIFF_BYTES = 8000;

/** A blob read from `cat-file --batch`. `content` is null when the blob was larger than the hold limit. */
export interface StreamedBlob {
  oid: string;
  size: number;
  /** The first BINARY_SNIFF_BYTES bytes (fewer for a smaller blob). */
  head: Buffer;
  /** Lines the way an editor counts them: newlines, plus one for a last line without its own. */
  lines: number;
  content: Buffer | null;
}

/** The longest cat-file header (`<oid> <type> <size>`, or `<name> missing`) accepted. */
const MAX_HEADER_BYTES = 1024;
/** Oids written to cat-file's stdin per write, so a long list never sits in memory as one string. */
const FEED_OIDS_PER_WRITE = 4096;
/** The start of git's stderr kept for an error message. */
const STDERR_KEEP_CHARS = 4096;

/** The output ended inside an element; the exit status of git says whether git or the pipe is to blame. */
class Truncated extends Error {}

/** Reads cat-file's stdout chunk by chunk, so a consumer that stops pulling stops the child too. */
class ChunkReader {
  private readonly iterator: AsyncIterator<unknown>;
  private chunk: Buffer = Buffer.alloc(0);
  private pos = 0;
  /** Set when the stream ended with an error instead of cleanly. */
  failure: Error | undefined;

  constructor(iterator: AsyncIterator<unknown>) {
    this.iterator = iterator;
  }

  private async more(): Promise<boolean> {
    while (this.pos >= this.chunk.length) {
      try {
        const next = await this.iterator.next();
        if (next.done === true) return false;
        this.chunk = next.value as Buffer;
        this.pos = 0;
      } catch (error) {
        this.failure = error as Error;
        return false;
      }
    }
    return true;
  }

  /** The next header line, or null when the output ends cleanly between blobs. */
  async header(): Promise<string | null> {
    const parts: Buffer[] = [];
    let length = 0;
    for (;;) {
      if (!(await this.more())) {
        if (length === 0) return null;
        throw new Truncated("git cat-file output ended inside a header");
      }
      const newline = this.chunk.indexOf(0x0a, this.pos);
      const end = newline === -1 ? this.chunk.length : newline;
      parts.push(this.chunk.subarray(this.pos, end));
      length += end - this.pos;
      this.pos = newline === -1 ? end : newline + 1;
      if (length > MAX_HEADER_BYTES) {
        throw new GitError("unexpected cat-file header: longer than 1024 bytes");
      }
      if (newline !== -1) return Buffer.concat(parts).toString("utf8");
    }
  }

  /** Passes the next `size` bytes to `sink` piece by piece, then consumes the newline after them. */
  async body(oid: string, size: number, sink: (piece: Buffer) => void): Promise<void> {
    const cutOff = new Truncated(`git cat-file output ended before the end of blob ${oid}`);
    for (let left = size; left > 0; ) {
      if (!(await this.more())) throw cutOff;
      const take = Math.min(left, this.chunk.length - this.pos);
      sink(this.chunk.subarray(this.pos, this.pos + take));
      this.pos += take;
      left -= take;
    }
    if (!(await this.more())) throw cutOff;
    if (this.chunk[this.pos++] !== 0x0a) {
      throw new GitError(`unexpected cat-file output: blob ${oid} is not followed by a newline`);
    }
  }
}

/** Resolves once `stream` can take more writes, or can take none (it closed or failed). */
function drained(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      stream.off("drain", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.once("drain", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

/**
 * Reads the given blobs through one `cat-file --batch`, in order (an oid listed twice is read
 * twice), one at a time. A blob of at most `holdLimit` bytes comes with its whole `content`; a
 * larger one is only counted and sniffed as it streams past, so memory stays bounded by the
 * largest blob held plus one pipe chunk. The child is read only as fast as the caller consumes:
 * a slow consumer stalls git instead of buffering its output.
 *
 * Throws GitError for an object that is not a blob, a git that cannot start or exits non-zero
 * (with git's own stderr), and output that ends early. Stopping the iteration early kills git.
 */
export async function* streamBlobs(
  repo: string,
  oids: readonly string[],
  holdLimit: number,
): AsyncGenerator<StreamedBlob, void, undefined> {
  if (oids.length === 0) return;
  const child = spawn("git", ["-C", repo, "cat-file", "--batch"], {
    env: scrubbedGitEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let spawnFailure: Error | undefined;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    if (stderr.length < STDERR_KEEP_CHARS) stderr += text;
  });
  child.stderr.on("error", () => {});
  // git may exit (or be killed) with input unread; its exit status explains that, not EPIPE.
  child.stdin.on("error", () => {});
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.on("error", (error) => {
      spawnFailure = error;
      resolve({ code: null, signal: null });
    });
  });
  /** Why git failed, or null when it ran and exited 0. */
  const exitProblem = async (): Promise<GitError | null> => {
    const { code, signal } = await closed;
    if (spawnFailure !== undefined) {
      return new GitError(`could not run git: ${spawnFailure.message}`);
    }
    if (code === 0) return null;
    const why = stderr.trim() || (signal === null ? `exit status ${code}` : `signal ${signal}`);
    const cause = gitFailureCause(repo, stderr);
    return new GitError(
      cause === undefined
        ? `git cat-file failed in ${repo}: ${why}`
        : `git cat-file failed in ${printable(repo)}: ${cause}`,
    );
  };

  const feed = async (): Promise<void> => {
    for (let i = 0; i < oids.length && !child.stdin.destroyed; i += FEED_OIDS_PER_WRITE) {
      const batch = `${oids.slice(i, i + FEED_OIDS_PER_WRITE).join("\n")}\n`;
      if (!child.stdin.write(batch)) await drained(child.stdin);
    }
    child.stdin.end();
  };
  void feed().catch(() => {});

  const iterator = child.stdout[Symbol.asyncIterator]();
  const reader = new ChunkReader(iterator);
  let finished = false;
  try {
    let count = 0;
    try {
      for (; count < oids.length; count++) {
        const line = await reader.header();
        if (line === null) break;
        const [oid, type, sizeText] = line.split(" ");
        const size = Number(sizeText);
        if (type === "missing" && oid !== undefined && isPartialClone(repo)) {
          throw new GitError(`object ${printable(oid)} is missing: ${PARTIAL_CLONE_CAUSE}`);
        }
        if (oid === undefined || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
          throw new GitError(`unexpected cat-file header: ${line}`);
        }
        const hold = size <= holdLimit;
        const held: Buffer[] = [];
        const headParts: Buffer[] = [];
        let headLength = 0;
        let newlines = 0;
        let last = 0;
        await reader.body(oid, size, (piece) => {
          if (hold) held.push(piece);
          else if (headLength < BINARY_SNIFF_BYTES) {
            const kept = Buffer.from(piece.subarray(0, BINARY_SNIFF_BYTES - headLength));
            headParts.push(kept);
            headLength += kept.length;
          }
          for (let at = piece.indexOf(0x0a); at !== -1; at = piece.indexOf(0x0a, at + 1))
            newlines++;
          last = piece[piece.length - 1] as number;
        });
        const content = hold ? Buffer.concat(held, size) : null;
        yield {
          oid,
          size,
          head: content?.subarray(0, BINARY_SNIFF_BYTES) ?? Buffer.concat(headParts),
          lines: size === 0 ? 0 : newlines + (last === 0x0a ? 0 : 1),
          content,
        };
      }
      if (count < oids.length) {
        throw new Truncated(`git cat-file output ended after ${count} of ${oids.length} blobs`);
      }
      // git exits at the end of its input, so anything further is output nobody asked for.
      const extra = await reader.header();
      if (extra !== null) {
        const shown = extra.length > 80 ? `${extra.slice(0, 80)}...` : extra;
        throw new GitError(
          `unexpected cat-file output after ${oids.length} requested blobs: ${shown}`,
        );
      }
    } catch (error) {
      if (!(error instanceof Truncated)) throw error;
      const cause = reader.failure === undefined ? "" : ` (${reader.failure.message})`;
      throw (await exitProblem()) ?? new GitError(`${error.message}${cause}`);
    }
    finished = true;
    const problem = await exitProblem();
    if (problem !== null) throw problem;
  } finally {
    if (!finished) child.kill("SIGKILL");
    child.stdin.destroy();
    await iterator.return?.();
  }
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
      if (nextToken && isSha(nextToken)) {
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
