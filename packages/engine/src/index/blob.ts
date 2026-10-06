import { assertSha, type GitOptions, git } from "./git.ts";

/** The most a blob People reads as text may hold: a mailmap or an ignore-revs list (1 MiB). */
export const MAX_BLOB_BYTES = 1 << 20;

/**
 * The UTF-8 text of `path` as committed at `sha` (spec v2 #6 R4, §6.1), read from git objects
 * and never from the work tree: `.mailmap` and `.git-blame-ignore-revs`. Null when the path is
 * not a regular file there, or is larger than `maxBytes` (MAX_BLOB_BYTES). The path is matched
 * literally (`--literal-pathspecs`), so no pathspec magic in it is read.
 */
export function readBlobAt(
  repo: string,
  sha: string,
  path: string,
  options: GitOptions & { maxBytes?: number } = {},
): string | null {
  assertSha(sha);
  const entry = git(
    repo,
    ["--literal-pathspecs", "ls-tree", "-z", "--long", "--full-tree", sha, "--", path],
    options,
  )
    .toString("utf8")
    .split("\0")
    .find((line) => line.slice(line.indexOf("\t") + 1) === path);
  if (entry === undefined) return null;
  const [mode, type, oid = "", size] = entry.slice(0, entry.indexOf("\t")).split(/ +/);
  if (type !== "blob" || mode === "120000" || Number(size) > (options.maxBytes ?? MAX_BLOB_BYTES))
    return null;
  return git(repo, ["cat-file", "blob", oid], options).toString("utf8");
}
