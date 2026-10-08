import { spawnSync } from "node:child_process";
import { assertSha, GitError, type GitOptions, git, gitEnv, isSha } from "./git.ts";
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
  /**
   * The author date, ISO 8601 in the author's own offset (R5); an invalid offset is read as
   * +00:00, and an undated commit holds its commit date here (the I3 ruling).
   */
  authorDate: string;
  /**
   * True when git's author date has a year outside 1970-9999: the commit counts in totals but
   * stays out of activity and first and last dates (the I3 ruling). Absent otherwise.
   */
  undated?: true;
  /** The committer date, as readHistory gives it, its offset read as +00:00 when invalid (I3). */
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
/** A date as git can print it: any year's length, any two-digit offset. */
const GIT_DATE = /^(\d{4,})(-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * The one form of every date People reads that reaches a schema (the I3 rulings): an offset past
 * +-23:59 is read as +00:00, the clock time kept; a year that is not four digits, or (for an
 * author date, `dated`) one outside 1970-9999, or a date that does not parse, gives null.
 */
export function schemaDate(raw: string, dated = true): string | null {
  const m = GIT_DATE.exec(raw);
  if (m === null) return null;
  const [, year = "", rest = "", offset = "", hours = "", minutes = ""] = m;
  if (year.length !== 4 || (dated && year < "1970")) return null;
  const valid = offset === "Z" || (Number(hours) <= 23 && Number(minutes) <= 59);
  const date = `${year}${rest}${valid ? offset : "+00:00"}`;
  return Number.isFinite(Date.parse(date)) ? date : null;
}
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;
/** The format's fields after its leading NUL: one token each, NUL-separated. */
const FIELDS = 8;

/** How long the People log may run before it is stopped (the fix-forward ruling: 10 minutes). */
export const AUTHORSHIP_TIMEOUT_MS = 600_000;
/** The most log output read: below V8's longest string, so decoding it cannot throw. */
export const AUTHORSHIP_MAX_BYTES = 256 * 1024 * 1024;

/** Whether `git version`'s output names git 2.40 or later, the first with `--attr-source`. */
export function attrSourceSupported(version: string): boolean {
  const match = /^git version (\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 2 || (major === 2 && minor >= 40);
}

let attributesAtSha: boolean | undefined;

/**
 * Whether this machine's git reads attributes at the sha (`--attr-source`, git 2.40 or later),
 * asked once. With an older git, attributes in the work tree may shape the counts, and the People
 * summary says so.
 */
export function gitReadsAttributesAtSha(): boolean {
  if (attributesAtSha === undefined) {
    const out = spawnSync("git", ["version"], { env: gitEnv(), timeout: 10_000 });
    attributesAtSha = attrSourceSupported(out.stdout?.toString("utf8") ?? "");
  }
  return attributesAtSha;
}

/** A numstat count; null for a binary change ("-"). */
const lines = (text: string): number | null => (text === "-" ? null : Number(text));

/**
 * The pinned log argv (C13, the fix-forward ruling): no replace refs, attributes read at the sha
 * (git 2.40 or later) and never from a configured attributes file, git's default big-file
 * threshold, UTF-8 output, renames on (copies off) with git's default limit, the root commit's
 * diff, myers, no merge diffs, no signature, no colour, external diff or textconv.
 */
export function authorshipArgs(sha: string, attributesAtSha: boolean): string[] {
  return [
    "--no-replace-objects",
    ...(attributesAtSha ? [`--attr-source=${sha}`] : []),
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.bigFileThreshold=512m",
    "-c",
    "i18n.logOutputEncoding=UTF-8",
    "-c",
    "diff.renames=true",
    "-c",
    "diff.renameLimit=1000",
    "log",
    "-z",
    "-M",
    "--root",
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
  ];
}

/**
 * Every commit reachable from `sha`, newest first by commit date, with its raw author, author
 * date, subject, a merge's title line, each changed file's numstat with renames followed, and the
 * pull request it arrived in (readHistory's assignment, shared). The log is parsed on NUL, which
 * no name, email, subject, body or path can hold, so repository text cannot move a record
 * boundary. Every option that shapes the counts is pinned in argv (authorshipArgs), so the counts
 * follow the sha, not the repository's config or work tree. The log stops after
 * AUTHORSHIP_TIMEOUT_MS and past AUTHORSHIP_MAX_BYTES of output, with a GitError, unless
 * `options` says otherwise.
 */
export function readAuthorship(
  repo: string,
  sha: string,
  options: GitOptions = {},
): AuthoredCommit[] {
  assertSha(sha);
  const tokens = git(repo, authorshipArgs(sha, gitReadsAttributesAtSha()), {
    timeoutMs: AUTHORSHIP_TIMEOUT_MS,
    maxBytes: AUTHORSHIP_MAX_BYTES,
    ...options,
  })
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
    const usable = schemaDate(authorDate);
    // The commit date takes the same form (its offset fixed): an undated commit stands on it.
    const committed = schemaDate(commitDate, false);
    if (committed === null) throw unparseable();
    commits.push({
      sha: hash,
      parents: parentShas,
      authorName: name,
      authorEmail: email,
      authorDate: usable ?? committed,
      ...(usable === null ? { undated: true as const } : {}),
      commitDate: committed,
      subject,
      mergeTitle: merge && titleLine !== undefined ? titleLine.trim() : null,
      files,
      pr: null,
    });
  }
  assignPullRequests(commits);
  return commits;
}
