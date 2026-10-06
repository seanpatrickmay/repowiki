import { spawn } from "node:child_process";
import { assertSha, GitError, GitTimeoutError, isSha, scrubbedGitEnv } from "./git.ts";

/** A run of consecutive lines of a file that blame gives one commit: `[commit sha, lines]`. */
export type BlameRun = [sha: string, lines: number];

/** How long one file's blame may run before it is stopped (spec v2 #6 §4 step 4). */
export const BLAME_TIMEOUT_MS = 120_000;
/** The most output one blame may write; a file's incremental blame is far smaller. */
const MAX_BLAME_OUTPUT = 256 * 1024 * 1024;

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

/** Runs git with the scrubbed environment and argv only, collecting stdout up to a cap. */
function gitAsync(repo: string, args: readonly string[], timeoutMs: number): Promise<string> {
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
      if (size > MAX_BLAME_OUTPUT) {
        failure ??= new GitError("git blame wrote more than 256 MiB");
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
      else if (code !== 0)
        reject(new GitError(`git blame failed: ${stderr.trim().split("\n")[0]}`));
      else resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

/**
 * Who wrote each line of `path` as it is at `sha` (spec v2 #6 R1, R2): `git blame --incremental
 * -C -C -M` with every option that shapes the answer pinned in argv, so no config or variable
 * can change it (scrubbedGitEnv strips the environment's; core.fsmonitor, the ignored and
 * unblamable markers, the diff algorithm and textconv are set here, and `--ignore-revs-file=`
 * clears any ignore-revs file the repository's config names). `ignoreRevs`
 * are full shas passed as --ignore-rev (R4). The path follows `--` and is literal; git blame's
 * own parser takes everything after `--end-of-options` as a revision, so the sha is checked to be
 * 40 hex instead. Stops after `timeoutMs` (BLAME_TIMEOUT_MS) with a GitTimeoutError.
 */
export async function blameFile(
  repo: string,
  sha: string,
  path: string,
  ignoreRevs: readonly string[] = [],
  options: { timeoutMs?: number } = {},
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
      "--literal-pathspecs",
      "blame",
      "--incremental",
      // An empty name clears blame.ignoreRevsFile's list; `-c blame.ignoreRevsFile=` does not.
      "--ignore-revs-file=",
      "-C",
      "-C",
      "-M",
      "--diff-algorithm=myers",
      "--no-textconv",
      ...ignoreRevs.flatMap((rev) => ["--ignore-rev", rev]),
      sha,
      "--",
      path,
    ],
    options.timeoutMs ?? BLAME_TIMEOUT_MS,
  );
  return parseIncrementalBlame(text);
}
