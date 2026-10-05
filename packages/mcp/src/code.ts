import type { CodeCitation, CommitCitation } from "@repowiki/core";
import { assertSha } from "@repowiki/engine";
import { count, cut, oneLine, toolText } from "@repowiki/query";
import { commitOf, gitOutput } from "./git.ts";

/** Lines of context cited_code shows around a cited range unless asked otherwise, and the most. */
export const DEFAULT_CONTEXT_LINES = 5;
export const MAX_CONTEXT_LINES = 20;
/** The largest file cited_code reads, by the size git reports; a bigger one is named, not read. */
export const MAX_CODE_BYTES = 2 * 1024 * 1024;
/** The most changed paths a commit citation lists. */
export const MAX_CHANGED_PATHS = 50;
/** The most code points of one source line shown; a longer line is cut. */
const MAX_LINE = 2000;
/** git's empty tree: what a root commit is diffed against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const sha7 = (sha: string) => sha.slice(0, 7);
const shown = (path: string) => cut(oneLine(path), 200);

/** A file at a commit, or why it cannot be read there. */
export type FileAt =
  | { text: string }
  | { missing: "no-commit" | "no-file" | "binary" | "too-large"; size?: number };

/**
 * The text of `path` at commit `sha` in `repo`, read from git objects only (ls-tree, then
 * cat-file of the blob), never the working tree. The path comes from a stored citation and is
 * given to ls-tree as a literal path after `--`, so it is never an option or a pattern.
 */
export function fileAt(repo: string, sha: string, path: string): FileAt {
  assertSha(sha);
  if (commitOf(repo, sha) !== sha) return { missing: "no-commit" };
  const listing = gitOutput(repo, [
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    "--full-tree",
    "--long",
    "--end-of-options",
    sha,
    "--",
    path,
  ]).toString("utf8");
  for (const entry of listing.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1 || entry.slice(tab + 1) !== path) continue;
    const [mode, type, oid, size] = entry.slice(0, tab).split(/ +/);
    if (type !== "blob" || mode === "120000" || oid === undefined) break;
    if (Number(size) > MAX_CODE_BYTES) return { missing: "too-large", size: Number(size) };
    const bytes = gitOutput(repo, ["cat-file", "blob", oid]);
    if (bytes.subarray(0, 8000).includes(0)) return { missing: "binary" };
    return { text: bytes.toString("utf8") };
  }
  return { missing: "no-file" };
}

/** Why a file cannot be shown, as one sentence. */
export function missingText(path: string, sha: string, file: Exclude<FileAt, { text: string }>) {
  switch (file.missing) {
    case "no-commit":
      return `The repository does not hold commit ${sha7(sha)}, so the cited code cannot be shown; fetch it, or read ${shown(path)} in the working tree.`;
    case "no-file":
      return `${shown(path)} is not in commit ${sha7(sha)}.`;
    case "binary":
      return `${shown(path)} is a binary file at commit ${sha7(sha)}.`;
    case "too-large":
      return `${shown(path)} is ${file.size} bytes at commit ${sha7(sha)}, over the ${MAX_CODE_BYTES}-byte limit; read it in the working tree.`;
  }
}

/**
 * A code citation's lines at its own commit with `context` lines around them, numbered, each
 * cited line marked `>`: what the claim rests on, exactly as it was cited.
 */
export function citedCode(repo: string, citation: CodeCitation, context: number): string {
  const file = fileAt(repo, citation.sha, citation.path);
  if (!("text" in file)) return `${missingText(citation.path, citation.sha, file)}\n`;
  const lines = toolText(file.text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const from = Math.max(1, citation.startLine - context);
  const to = Math.min(lines.length, citation.endLine + context);
  const symbol = citation.symbol === null ? "" : `, ${oneLine(citation.symbol)}`;
  const body: string[] = [];
  for (let n = from; n <= to; n++) {
    const mark = n >= citation.startLine && n <= citation.endLine ? ">" : " ";
    body.push(`${mark} ${n}\t${cut(lines[n - 1] ?? "", MAX_LINE)}`);
  }
  const heading = `${shown(citation.path)} at commit ${sha7(citation.sha)}, lines ${from}-${to} of ${lines.length} (cited: ${citation.startLine}-${citation.endLine}${symbol}):`;
  return `${[heading, ...body].join("\n")}\n`;
}

/**
 * A commit citation's commit: sha, commit date, subject, pull request and up to
 * MAX_CHANGED_PATHS changed paths with added and removed line counts, never a diff body or an
 * author. A commit the repository lacks is shown from the citation alone.
 */
export function commitDetails(repo: string, citation: CommitCitation): string {
  assertSha(citation.sha);
  const pr = citation.pr === null ? [] : [`Pull request: #${citation.pr}`];
  if (commitOf(repo, citation.sha) !== citation.sha) {
    return `${[
      `commit ${citation.sha}`,
      `Subject: ${oneLine(citation.subject)}`,
      ...pr,
      "The repository does not hold this commit, so its changes cannot be listed.",
    ].join("\n")}\n`;
  }
  const [, date = "", parents = "", subject = ""] = gitOutput(repo, [
    "show",
    "-s",
    "--no-color",
    "--format=%H%x00%cI%x00%P%x00%s",
    citation.sha,
  ])
    .toString("utf8")
    .replace(/\n$/, "")
    .split("\0");
  const parent = parents.split(" ")[0] || EMPTY_TREE;
  const fields = gitOutput(repo, [
    "diff",
    "--numstat",
    "-z",
    "--no-renames",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--end-of-options",
    parent,
    citation.sha,
  ])
    .toString("utf8")
    .split("\0")
    .filter((field) => field !== "");
  const files = fields.map((field) => {
    const [added = "", removed = "", ...rest] = field.split("\t");
    const lines = added === "-" ? "binary" : `+${added} -${removed}`;
    return `- ${shown(rest.join("\t"))}: ${lines}`;
  });
  const more =
    files.length > MAX_CHANGED_PATHS ? [`- and ${files.length - MAX_CHANGED_PATHS} more`] : [];
  const merge = parents.includes(" ") ? " (a merge: changes against its first parent)" : "";
  return `${[
    `commit ${citation.sha}, ${date.slice(0, 10)}`,
    `Subject: ${oneLine(subject)}`,
    ...pr,
    `${count(files.length, "changed file")}${merge}:`,
    ...files.slice(0, MAX_CHANGED_PATHS),
    ...more,
  ].join("\n")}\n`;
}
