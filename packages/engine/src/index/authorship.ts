import { assertSha, GitError, type GitOptions, git, isSha } from "./git.ts";
import { assignPullRequests } from "./history.ts";

/** One file a commit changed, with its line counts (spec v2 #6 R20). */
export interface AuthoredFile {
  /** The path after the commit. */
  path: string;
  /** The path before it, for a rename (git's -M); null otherwise. */
  oldPath: string | null;
  /** Lines added and deleted; null for a binary change. */
  added: number | null;
  deleted: number | null;
}

/** One commit reachable from the read sha, as People attributes it (spec v2 #6 R5, R6). */
export interface AuthoredCommit {
  sha: string;
  /** Parent shas; two or more for a merge. */
  parents: string[];
  /** The author as git stored it: never the mailmap's %aN (R5); untrusted text. */
  authorName: string;
  authorEmail: string;
  /** The author date, ISO 8601 in the author's own offset (R5). */
  authorDate: string;
  /** The committer date, as readHistory gives it. */
  commitDate: string;
  subject: string;
  /** A merge's first non-empty body line, where GitHub writes the PR's title (R6); else null. */
  mergeTitle: string | null;
  /** Files the commit changed, renames followed (-M); empty for a merge. */
  files: AuthoredFile[];
  /** The pull request that brought the commit in, as readHistory assigns it. */
  pr: number | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;
/** The format's fields after its leading NUL: one token each, NUL-separated. */
const FIELDS = 8;

/** A numstat count; null for a binary change ("-"). */
const lines = (text: string): number | null => (text === "-" ? null : Number(text));

/**
 * Every commit reachable from `sha`, newest first by commit date, with its raw author, author
 * date, subject, a merge's title line, each changed file's numstat with renames followed, and the
 * pull request it arrived in (readHistory's assignment, shared). The log is parsed on NUL, which
 * no name, email, subject, body or path can hold, so repository text cannot move a record
 * boundary. Every option that shapes the counts is pinned in argv (C13): myers, renames on and
 * copies off, no merge diffs, no signature, no external diff or textconv.
 */
export function readAuthorship(
  repo: string,
  sha: string,
  options: GitOptions = {},
): AuthoredCommit[] {
  assertSha(sha);
  const tokens = git(
    repo,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.renames=true",
      "-c",
      "diff.renameLimit=1000",
      "log",
      "-z",
      "-M",
      "--numstat",
      "--diff-merges=off",
      "--diff-algorithm=myers",
      "--no-show-signature",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--format=%x00%H%x00%P%x00%aI%x00%cI%x00%an%x00%ae%x00%s%x00%b",
      "--end-of-options",
      sha,
    ],
    options,
  )
    .toString("utf8")
    .split("\0");
  const unparseable = () => new GitError(`unparseable commit record in git log of ${sha}`);
  const commits: AuthoredCommit[] = [];
  let i = 0;
  while (i < tokens.length) {
    // An empty token then a sha starts a record; the output ends with one empty token.
    if (tokens[i] === "" && i === tokens.length - 1) break;
    if (tokens[i] !== "") throw unparseable();
    const [hash = "", parents = "", authorDate = "", commitDate = "", name, email, subject, body] =
      tokens.slice(i + 1, i + 1 + FIELDS);
    const parentShas = parents === "" ? [] : parents.split(" ");
    if (
      !isSha(hash) ||
      !parentShas.every(isSha) ||
      !ISO_DATE.test(authorDate) ||
      !ISO_DATE.test(commitDate) ||
      name === undefined ||
      email === undefined ||
      subject === undefined ||
      body === undefined
    ) {
      throw unparseable();
    }
    i += 1 + FIELDS;
    const files: AuthoredFile[] = [];
    for (let first = true; i < tokens.length && tokens[i] !== ""; first = false) {
      // The format's own terminating newline leads the first entry.
      const entry = first ? (tokens[i] as string).replace(/^\n/, "") : (tokens[i] as string);
      const stat = NUMSTAT.exec(entry);
      if (stat === null) throw unparseable();
      const [, added = "", deleted = "", path = ""] = stat;
      if (path === "") {
        // A rename: "added\tdeleted\t", then the old and the new path.
        const oldPath = tokens[i + 1];
        const newPath = tokens[i + 2];
        if (oldPath === undefined || newPath === undefined || oldPath === "" || newPath === "")
          throw unparseable();
        files.push({ path: newPath, oldPath, added: lines(added), deleted: lines(deleted) });
        i += 3;
      } else {
        files.push({ path, oldPath: null, added: lines(added), deleted: lines(deleted) });
        i += 1;
      }
    }
    const merge = parentShas.length > 1;
    const titleLine = body.split("\n").find((line) => line.trim() !== "");
    commits.push({
      sha: hash,
      parents: parentShas,
      authorName: name,
      authorEmail: email,
      authorDate,
      commitDate,
      subject,
      mergeTitle: merge && titleLine !== undefined ? titleLine.trim() : null,
      files,
      pr: null,
    });
  }
  assignPullRequests(commits);
  return commits;
}
