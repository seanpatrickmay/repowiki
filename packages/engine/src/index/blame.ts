import { spawn } from "node:child_process";
import {
  assertSha,
  GitError,
  GitTimeoutError,
  gitFailureCause,
  isSha,
  scrubbedGitEnv,
} from "./git.ts";

/** A run of consecutive lines of a file that blame gives one commit: `[commit sha, lines]`. */
export type BlameRun = [sha: string, lines: number];

/** How long one file's blame may run before it is stopped (spec v2 #6 §4 step 4). */
export const BLAME_TIMEOUT_MS = 120_000;
/** The most output one blame may write; a file's incremental blame is far smaller. */
export const MAX_BLAME_OUTPUT = 256 * 1024 * 1024;

/**
 * A blame that cannot run for a reason outside the file's history: a configured
 * blame.ignoreRevsFile git cannot read, a repository git refuses, a partial clone's missing blob,
 * or output past the cap. The message is the cause; the caller counts the file's lines as
 * unattributed instead of failing (the fix-forward ruling: a hostile repository must not break
 * People). Still a GitError.
 */
export class BlameSkippedError extends GitError {}

/**
 * What git says when the repository's config names a blame.ignoreRevsFile it cannot open or
 * parse (git opens every configured file before `--ignore-revs-file=` clears the list, and
 * `-c blame.ignoreRevsFile=` does not stop it either; checked on git 2.47). Whole lines.
 */
const IGNORE_FILE_STDERR = /^fatal: (?:could not open object name list|invalid object name): /m;

const IGNORE_FILE_CAUSE =
  "blame.ignoreRevsFile in your git config names a file git cannot read; RepoWiki does not use " +
  "it, but git opens it anyway: create the file or unset the key";

/** Why a failed blame failed: a cause outside the file (BlameSkippedError), else a GitError. */
function blameFailure(repo: string, stderr: string): GitError {
  if (IGNORE_FILE_STDERR.test(stderr)) return new BlameSkippedError(IGNORE_FILE_CAUSE);
  const cause = gitFailureCause(repo, stderr, { unreadableObject: true });
  if (cause !== undefined) return new BlameSkippedError(cause);
  return new GitError(`git blame failed: ${stderr.trim().split("\n")[0]}`);
}

const HEADER = /^([0-9a-f]{40}) (\d+) (\d+) (\d+)$/;

/**
 * The runs of `git blame --incremental` output, in line order, adjacent runs of one commit
 * merged. Only each group's header (`<sha> <orig> <final> <count>`) is read, statefully: after a
 * header every line up to its `filename` line is the group's metadata (names, subjects), which
 * blame writes one per line and which may hold any text, so a subject shaped like a header
 * cannot start a group. Author names are never read (R2: blame applies the work tree's mailmap).
 */
export function parseIncrementalBlame(text: string): BlameRun[] {
  const groups: { final: number; count: number; sha: string }[] = [];
  let inGroup = false;
  for (const line of text.split("\n")) {
    if (inGroup) {
      if (line.startsWith("filename ")) inGroup = false;
      continue;
    }
    if (line === "") continue;
    const header = HEADER.exec(line);
    if (header === null) throw new GitError("unparseable git blame output");
    groups.push({ sha: header[1] as string, final: Number(header[3]), count: Number(header[4]) });
    inGroup = true;
  }
  if (inGroup) throw new GitError("git blame output ended inside a group");
  groups.sort((a, b) => a.final - b.final);
  const runs: BlameRun[] = [];
  let next = 1;
  for (const group of groups) {
    if (group.final !== next || group.count < 1)
      throw new GitError("git blame output does not cover the file's lines in order");
    next += group.count;
    const last = runs.at(-1);
    if (last !== undefined && last[0] === group.sha) last[1] += group.count;
    else runs.push([group.sha, group.count]);
  }
  return runs;
}

/** Runs git with the scrubbed environment and argv only, collecting stdout up to `maxBytes`. */
function gitAsync(
  repo: string,
  args: readonly string[],
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, ...args], {
      env: scrubbedGitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let failure: Error | null = null;
    const timer = setTimeout(() => {
      failure = new GitTimeoutError(`git blame timed out after ${timeoutMs} ms`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        failure ??= new BlameSkippedError(`git blame wrote more than ${maxBytes} bytes`);
        child.kill("SIGKILL");
      } else out.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      if (stderr.length < 4096) stderr += text;
    });
    child.on("error", (error) => {
      failure ??= new GitError(`could not run git: ${error.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure !== null) reject(failure);
      else if (code !== 0) reject(blameFailure(repo, stderr));
      else resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

/**
 * Who wrote each line of `path` as it is at `sha` (spec v2 #6 R1, R2): `git blame --incremental
 * -C -C -M` with every option that shapes the answer pinned in argv, so no config or variable
 * can change it: scrubbedGitEnv strips the environment's; the ignored and unblamable markers,
 * the indent heuristic, the diff algorithm and textconv are set here, and `--ignore-revs-file=`
 * clears the ignore-revs files the repository's config names (`-c blame.ignoreRevsFile=` too).
 * core.fsmonitor and `--literal-pathspecs` are guards: blame at a sha runs no fsmonitor hook and
 * reads its one path literally on git 2.47 without them. `ignoreRevs` are full shas of commits
 * the repository has (git refuses an unknown one), passed as --ignore-rev (R4). The path follows
 * `--`; git blame's own parser takes everything after `--end-of-options` as a revision, so the
 * sha is checked to be 40 hex instead. Stops after `timeoutMs` (BLAME_TIMEOUT_MS) with a
 * GitTimeoutError; a cause outside the file (a configured ignore file git cannot read, output
 * past `maxBytes`) is a BlameSkippedError.
 */
export async function blameFile(
  repo: string,
  sha: string,
  path: string,
  ignoreRevs: readonly string[] = [],
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<BlameRun[]> {
  assertSha(sha);
  for (const rev of ignoreRevs) if (!isSha(rev)) throw new GitError("not a 40-hex ignore-rev");
  const text = await gitAsync(
    repo,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "blame.markIgnoredLines=false",
      "-c",
      "blame.markUnblamableLines=false",
      "-c",
      "diff.algorithm=myers",
      "-c",
      "blame.ignoreRevsFile=",
      "--literal-pathspecs",
      "blame",
      "--incremental",
      // An empty name clears blame.ignoreRevsFile's list; `-c blame.ignoreRevsFile=` alone does
      // not. git still opens every configured file first (BlameSkippedError when it cannot).
      "--ignore-revs-file=",
      "-C",
      "-C",
      "-M",
      "--diff-algorithm=myers",
      "--indent-heuristic",
      "--no-textconv",
      ...ignoreRevs.flatMap((rev) => ["--ignore-rev", rev]),
      sha,
      "--",
      path,
    ],
    options.timeoutMs ?? BLAME_TIMEOUT_MS,
    options.maxBytes ?? MAX_BLAME_OUTPUT,
  );
  return parseIncrementalBlame(text);
}
