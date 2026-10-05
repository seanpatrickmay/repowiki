import { spawnSync } from "node:child_process";
import { assertSha, GitError, type GitOptions, git, scrubbedGitEnv, timeoutError } from "./git.ts";
import { pullRequestOf } from "./history.ts";

/**
 * One hunk of a zero-context diff, as git writes it: `oldCount` lines from `oldStart` became
 * `newCount` lines from `newStart`. A count of 0 is a pure insertion (old side) or deletion (new
 * side), placed after line `oldStart` or `newStart`.
 */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** How one regular file differs between two commits. */
export interface FileChange {
  status: "added" | "modified" | "deleted" | "renamed";
  /** The path at the older commit; null when the file was added. */
  oldPath: string | null;
  /** The path at the newer commit; null when the file was deleted. */
  newPath: string | null;
  /** The changed line ranges of a modified or renamed text file, in order; empty otherwise. */
  hunks: Hunk[];
  /**
   * True when git diffs the two versions of a modified or renamed file as binary, so there are no
   * hunks to follow. An added or deleted file is never flagged: it has no other version, and its
   * `hunks` are empty either way.
   */
  binary: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The hunks of a `git diff -U0` text, and whether git called the files binary. */
export function parseHunks(diff: string): { hunks: Hunk[]; binary: boolean } {
  const hunks: Hunk[] = [];
  let binary = false;
  for (const line of diff.split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (match !== null) {
      hunks.push({
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
      });
    } else if (line.startsWith("Binary files ")) binary = true;
  }
  return { hunks, binary };
}

/** A regular file's mode (100644 or 100755); symlinks and submodules are not indexed. */
const isFile = (mode: string): boolean => mode.startsWith("100");

/**
 * Hunks between two blobs, by object id, so no path is ever parsed out of diff text. Every option
 * that shapes hunks is pinned, so neither git config (diff.interHunkContext, diff.algorithm,
 * diff.indentHeuristic) nor GIT_DIFF_OPTS (dropped by scrubbedGitEnv) can widen or move them.
 */
function blobHunks(
  repo: string,
  oldOid: string,
  newOid: string,
  options: GitOptions,
): { hunks: Hunk[]; binary: boolean } {
  if (oldOid === newOid) return { hunks: [], binary: false };
  const text = git(
    repo,
    [
      "diff",
      "-U0",
      "--inter-hunk-context=0",
      "--diff-algorithm=myers",
      "--no-indent-heuristic",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--end-of-options",
      oldOid,
      newOid,
    ],
    options,
  ).toString("utf8");
  return parseHunks(text);
}

/**
 * Every regular file that differs between commits `from` and `to`, with its line hunks: git's
 * rename detection (-M) pairs a moved file with its new path. Read-only plumbing, NUL-separated,
 * so no path text can forge an entry. A symlink or submodule is not a file: one that became a
 * file is added, a file that became one is deleted. A copy that the caller's git config reports
 * counts as an added file. With `only`, just the changes whose first path is in it are returned
 * (the old path; a new file's path; a copy's source), and only they are diffed for hunks; renames are still paired over the whole
 * tree, so a cited file that moved is followed (the MCP server's per-claim marks, M8). With
 * `options.timeoutMs`, each git call it makes is stopped after that long (a GitTimeoutError).
 */
export function diffCommits(
  repo: string,
  from: string,
  to: string,
  only?: ReadonlySet<string>,
  options: GitOptions = {},
): FileChange[] {
  assertSha(from);
  assertSha(to);
  if (from === to) return [];
  const tokens = git(
    repo,
    [
      "diff",
      "--raw",
      "-z",
      "-M",
      "--no-abbrev",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--end-of-options",
      from,
      to,
    ],
    options,
  )
    .toString("utf8")
    .split("\0");
  const changes: FileChange[] = [];
  let i = 0;
  while (i < tokens.length && tokens[i] !== "") {
    const meta = tokens[i] as string;
    const [srcMode = "", dstMode = "", srcOid = "", dstOid = "", status = ""] = meta
      .slice(1)
      .split(" ");
    if (!meta.startsWith(":") || status === "") {
      throw new GitError(`unparseable diff entry between ${from} and ${to}`);
    }
    const twoPaths = status.startsWith("R") || status.startsWith("C");
    const first = tokens[i + 1] ?? "";
    const second = twoPaths ? (tokens[i + 2] ?? "") : first;
    i += twoPaths ? 3 : 2;
    if (only !== undefined && !only.has(first)) continue;
    const was = isFile(srcMode);
    const is = isFile(dstMode);
    const kind = status[0];
    if (kind === "R" && was && is) {
      changes.push({
        status: "renamed",
        oldPath: first,
        newPath: second,
        ...blobHunks(repo, srcOid, dstOid, options),
      });
    } else if (kind === "M" || kind === "T" || kind === "R") {
      if (was && is) {
        changes.push({
          status: "modified",
          oldPath: first,
          newPath: second,
          ...blobHunks(repo, srcOid, dstOid, options),
        });
      } else if (was) {
        changes.push({
          status: "deleted",
          oldPath: first,
          newPath: null,
          hunks: [],
          binary: false,
        });
      } else if (is) {
        changes.push({ status: "added", oldPath: null, newPath: second, hunks: [], binary: false });
      }
    } else if ((kind === "A" || kind === "C") && is) {
      changes.push({ status: "added", oldPath: null, newPath: second, hunks: [], binary: false });
    } else if (kind === "D" && was) {
      changes.push({ status: "deleted", oldPath: first, newPath: null, hunks: [], binary: false });
    }
  }
  return changes;
}

/**
 * True when `ancestor` is `descendant` or one of its ancestors. With `options.timeoutMs`, a git
 * that runs longer is stopped (a GitTimeoutError).
 */
export function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
  options: GitOptions = {},
): boolean {
  assertSha(ancestor);
  assertSha(descendant);
  const args = ["merge-base", "--is-ancestor", ancestor, descendant];
  const out = spawnSync("git", ["-C", repo, ...args], {
    env: scrubbedGitEnv(),
    timeout: options.timeoutMs,
  });
  if (out.error) {
    throw (
      timeoutError(out.error, repo, args, options.timeoutMs) ??
      new GitError(`could not run git: ${out.error.message}`)
    );
  }
  if (out.status === 0) return true;
  if (out.status === 1) return false;
  throw new GitError(`git merge-base failed in ${repo}: ${out.stderr.toString("utf8").trim()}`);
}

/** Every commit reachable from `sha`, itself included. */
export function reachableCommits(repo: string, sha: string): Set<string> {
  assertSha(sha);
  const out = git(repo, ["rev-list", "--end-of-options", sha]).toString("utf8");
  return new Set(out.split("\n").filter((line) => line !== ""));
}

/** One commit a replay moves the wiki to. */
export interface ReplayStep {
  sha: string;
  subject: string;
  /** True for a merge commit; false for a squash-merged pull request's commit, or `to`. */
  merge: boolean;
}

/**
 * The commits a replay from `from` to `to` moves the wiki through (spec §6.2): every merge on
 * `to`'s first-parent line after `from`, and every commit there whose subject names a pull
 * request (a squash merge's trailing "(#N)", see pullRequestOf), oldest first, then `to` itself
 * when it is neither, so the replay ends where it was asked to. `from` must be an ancestor of `to`.
 */
export function replaySteps(repo: string, from: string, to: string): ReplayStep[] {
  assertSha(from);
  assertSha(to);
  if (!isAncestor(repo, from, to)) {
    throw new GitError(`${from} is not an ancestor of ${to}`);
  }
  const out = git(repo, [
    "rev-list",
    "--first-parent",
    "--reverse",
    "--format=%H %P%x00%s",
    "--end-of-options",
    `${from}..${to}`,
  ]).toString("utf8");
  const commits = out
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("commit "))
    .map((line) => {
      const [shas = "", subject = ""] = line.split("\0");
      const [sha = "", ...parents] = shas.trim().split(" ");
      return { sha, subject, merge: parents.length > 1 };
    });
  // The last commit listed is `to`'s commit: compared by position, not by sha, since `to` may
  // be an annotated tag's own id, which git peels to the commit it lists.
  const steps = commits.filter(
    (c, i) => c.merge || i === commits.length - 1 || pullRequestOf(c.subject) !== null,
  );
  return steps;
}
