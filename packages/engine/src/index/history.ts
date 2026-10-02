import { GitError, git, listBlobs, readBlobs } from "./git.ts";

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

const SHA = /^[0-9a-f]{40}$/;

/** A sha reaches git only as a full 40-hex id, never as a ref, a range or an option. */
function assertSha(sha: string): void {
  if (!SHA.test(sha)) throw new GitError(`not a 40-hex commit sha: ${JSON.stringify(sha)}`);
}

/** Every commit reachable from `sha`, newest first, with the PR each one arrived in. */
export function readHistory(repo: string, sha: string): CommitInfo[] {
  assertSha(sha);
  const out = git(repo, [
    "log",
    "-z",
    "--no-renames",
    "--name-only",
    "--format=%x1e%H%x1f%P%x1f%cI%x1f%s",
    sha,
  ]).toString("utf8");
  const commits: CommitInfo[] = [];
  for (const record of out.split("\x1e")) {
    if (record === "") continue;
    const end = record.indexOf("\0");
    const header = end === -1 ? record : record.slice(0, end);
    const [hash = "", parents = "", date = "", ...subject] = header.split("\x1f");
    const parentShas = parents === "" ? [] : parents.split(" ");
    // Subjects are untrusted text: one that carries the record separator splits a record in two.
    if (!SHA.test(hash) || !parentShas.every((p) => SHA.test(p))) {
      throw new GitError(`unparseable commit record in git log of ${sha}`);
    }
    const files = (end === -1 ? "" : record.slice(end + 1))
      .replace(/^\n/, "")
      .split("\0")
      .filter((path) => path !== "");
    commits.push({
      sha: hash,
      parents: parentShas,
      date,
      subject: subject.join("\x1f"),
      files,
      pr: null,
    });
  }
  assignPullRequests(commits);
  return commits;
}

/** "Merge pull request #12 from …", or a squash merge's "Title (#12)". */
export function pullRequestOf(subject: string): number | null {
  const match = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
  return match === null ? null : Number(match[1]);
}

/**
 * Walks the first-parent chain oldest first. A merge "Merge pull request #N" gives N to itself and
 * to every commit its second parent brought in; any other commit keeps the PR its own subject names.
 */
function assignPullRequests(commits: CommitInfo[]): void {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const chain: CommitInfo[] = [];
  for (let c = commits[0]; c !== undefined; c = bySha.get(c.parents[0] ?? "")) chain.push(c);
  const seen = new Set<string>();
  const mark = (start: string, pr: number | null): void => {
    const stack = [start];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      const commit = bySha.get(sha);
      if (commit === undefined || seen.has(sha)) continue;
      seen.add(sha);
      commit.pr = pullRequestOf(commit.subject) ?? pr;
      stack.push(...commit.parents);
    }
  };
  for (const commit of chain.reverse()) {
    const pr = pullRequestOf(commit.subject);
    // Older first-parent commits are already seen, so only what this merge brought in is marked.
    for (const parent of commit.parents.slice(1)) mark(parent, pr);
    mark(commit.sha, pr);
  }
}

/** UTF-8 text of every regular file at `sha` up to maxBytes, by path; binary files are left out. */
export function readSources(repo: string, sha: string, maxBytes: number): Map<string, string> {
  assertSha(sha);
  const blobs = listBlobs(repo, sha).filter((blob) => blob.size <= maxBytes);
  const contents = readBlobs(
    repo,
    blobs.map((blob) => blob.oid),
  );
  const sources = new Map<string, string>();
  for (const blob of blobs) {
    const content = contents.get(blob.oid);
    if (content === undefined || content.subarray(0, 8000).includes(0)) continue;
    sources.set(blob.path, content.toString("utf8"));
  }
  return sources;
}
