import { assertSha, GitError, type GitOptions, git, isSha, listBlobs, streamBlobs } from "./git.ts";

/** One commit reachable from the indexed sha. */
export interface CommitInfo {
  sha: string;
  /** Parent shas; two or more for a merge. */
  parents: string[];
  /** Committer date, ISO 8601 with the committer's offset. */
  date: string;
  subject: string;
  /** Paths the commit changed (renames as delete + add); empty for merges. */
  files: string[];
  /** The pull request that brought the commit into the first-parent history, if known. */
  pr: number | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Every commit reachable from `sha`, newest first by commit date, with the PR each one arrived in.
 * The log is parsed on NUL, which cannot occur in a subject, a path, a parent list or a date, so
 * nothing in the repository's own text can move a record boundary.
 */
export function readHistory(repo: string, sha: string, options: GitOptions = {}): CommitInfo[] {
  assertSha(sha);
  const tokens = git(
    repo,
    [
      "log",
      "-z",
      "--no-renames",
      "--name-only",
      "--format=%x00%H%x00%P%x00%cI%x00%s",
      "--end-of-options",
      sha,
    ],
    options,
  )
    .toString("utf8")
    .split("\0");
  const commits: CommitInfo[] = [];
  let i = 0;
  while (i < tokens.length) {
    // An empty token starts a record (a path is never empty); the output also ends with one.
    if (tokens[i] === "" && i === tokens.length - 1) break;
    if (tokens[i] !== "") {
      throw new GitError(`unparseable commit record in git log of ${sha}`);
    }
    const [hash, parents, date, subject] = tokens.slice(i + 1, i + 5);
    const parentShas = parents === "" ? [] : (parents?.split(" ") ?? []);
    if (
      hash === undefined ||
      subject === undefined ||
      !isSha(hash) ||
      !parentShas.every(isSha) ||
      !ISO_DATE.test(date ?? "")
    ) {
      throw new GitError(`unparseable commit record in git log of ${sha}`);
    }
    i += 5;
    const files: string[] = [];
    for (let first = true; i < tokens.length && tokens[i] !== ""; i++, first = false) {
      // The format's own terminating newline leads the first path.
      const path = first ? (tokens[i] as string).replace(/^\n/, "") : (tokens[i] as string);
      if (path !== "") files.push(path);
    }
    commits.push({
      sha: hash,
      parents: parentShas,
      date: date as string,
      subject,
      files,
      pr: null,
    });
  }
  assignPullRequests(commits);
  return commits;
}

/** "Merge pull request #12 from …", or a squash merge's "Title (#12)"; at most 9 digits. */
export function pullRequestOf(subject: string): number | null {
  const match =
    /^Merge pull request #(\d{1,9})\b/.exec(subject) ?? /\(#(\d{1,9})\)\s*$/.exec(subject);
  return match === null ? null : Number(match[1]);
}

/**
 * Walks the first-parent chain oldest first. A commit takes the number of the innermost
 * "Merge pull request #N" that brought it in: that merge's second and later parents (and what they
 * reached) get N, its first parent keeps the enclosing number. Any other commit keeps the PR its own
 * subject names, else the number it was reached with.
 */
function assignPullRequests(commits: CommitInfo[]): void {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const chain: CommitInfo[] = [];
  for (let c = commits[0]; c !== undefined; c = bySha.get(c.parents[0] ?? "")) chain.push(c);
  const seen = new Set<string>();
  const mark = (start: string): void => {
    const stack: [string, number | null][] = [[start, null]];
    while (stack.length > 0) {
      const [sha, pr] = stack.pop() as [string, number | null];
      const commit = bySha.get(sha);
      if (commit === undefined || seen.has(sha)) continue;
      seen.add(sha);
      const own = pullRequestOf(commit.subject);
      commit.pr = own ?? pr;
      const [first, ...merged] = commit.parents;
      const isPullRequestMerge = own !== null && /^Merge pull request #/.test(commit.subject);
      // The stack pops the first parent first, so the enclosing line claims a fork point before
      // the merged side can.
      for (const parent of merged) stack.push([parent, isPullRequestMerge ? own : pr]);
      if (first !== undefined) stack.push([first, pr]);
    }
  };
  // Older first-parent commits are already seen, so only what each merge brought in is marked.
  for (const commit of chain.reverse()) mark(commit.sha);
}

/**
 * UTF-8 text of every regular file at `sha` (a commit, or a tree) up to maxBytes, by path; binary
 * files are left out. The blobs are streamed through one `cat-file --batch` (each distinct blob
 * once, held whole only up to maxBytes, which none of the listed blobs exceeds), so no git output
 * is buffered whole. With `only`, just those paths are read.
 */
export async function readSources(
  repo: string,
  sha: string,
  maxBytes: number,
  options: GitOptions & { only?: ReadonlySet<string> } = {},
): Promise<Map<string, string>> {
  assertSha(sha);
  const { only } = options;
  const blobs = listBlobs(repo, sha, options).filter(
    (blob) => blob.size <= maxBytes && (only === undefined || only.has(blob.path)),
  );
  const oids = [...new Set(blobs.map((blob) => blob.oid))];
  // The text of each distinct blob (null for a binary one), decoded as it streams past.
  const texts = new Map<string, string | null>();
  let next = 0;
  for await (const data of streamBlobs(repo, oids, maxBytes, options)) {
    const oid = oids[next++] as string;
    if (data.oid !== oid) throw new GitError(`cat-file returned ${data.oid} for ${oid}`);
    if (data.content === null) throw new GitError(`cat-file held no content for blob ${oid}`);
    texts.set(oid, data.head.includes(0) ? null : data.content.toString("utf8"));
  }
  const missing = oids[next];
  if (missing !== undefined) throw new GitError(`missing content for blob ${missing}`);
  const sources = new Map<string, string>();
  for (const blob of blobs) {
    const text = texts.get(blob.oid);
    if (text === undefined || text === null) continue;
    sources.set(blob.path, text);
  }
  return sources;
}
