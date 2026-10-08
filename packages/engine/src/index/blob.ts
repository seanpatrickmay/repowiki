import { assertSha, type GitOptions, git } from "./git.ts";

/** The most a blob People reads as text may hold: a mailmap or an ignore-revs list (1 MiB). */
export const MAX_BLOB_BYTES = 1 << 20;

/**
 * The UTF-8 text of `path` as committed at `sha` (spec v2 #6 R4, §6.1), read from git objects
 * and never from the work tree: `.mailmap` and `.git-blame-ignore-revs`. Null when the path is
 * not a regular file there, or is larger than `maxBytes` (MAX_BLOB_BYTES; a NaN or negative bound
 * reads nothing). The path is matched
 * literally (`--literal-pathspecs`), so no pathspec magic in it is read.
 */
export function readBlobAt(
  repo: string,
  sha: string,
  path: string,
  options: GitOptions & { maxBytes?: number } = {},
): string | null {
  assertSha(sha);
  // maxBytes bounds the blob, not git's output: each call keeps git's own cap.
  const { maxBytes = MAX_BLOB_BYTES, ...gitOptions } = options;
  const entry = git(
    repo,
    ["--literal-pathspecs", "ls-tree", "-z", "--long", "--full-tree", sha, "--", path],
    gitOptions,
  )
    .toString("utf8")
    .split("\0")
    .find((line) => line.slice(line.indexOf("\t") + 1) === path);
  if (entry === undefined) return null;
  const [mode, type, oid = "", size] = entry.slice(0, entry.indexOf("\t")).split(/ +/);
  // Written to fail closed: a NaN or negative bound, or a size that is not a number, reads nothing.
  if (type !== "blob" || mode === "120000" || !(maxBytes >= 0) || !(Number(size) <= maxBytes))
    return null;
  return git(repo, ["cat-file", "blob", oid], gitOptions).toString("utf8");
}
