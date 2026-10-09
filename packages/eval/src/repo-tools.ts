import { assertSha, GitError, gitFailureCause, listBlobs, type TreeBlob } from "@repowiki/engine";
import {
  count,
  cut,
  defineTool,
  type LocalToolSet,
  MAX_TOOL_RESULT_CHARS,
  oneLine,
  ToolError,
  toolSet,
  toolText,
} from "@repowiki/query";
import { z } from "zod";
import { runGit, topLevel } from "./git.ts";

/** The most paths list_files names before it summarizes by directory instead. */
export const MAX_LISTED_FILES = 400;
/** The most lines one read_file call returns. */
export const MAX_READ_LINES = 400;
/** The most matching lines one grep call returns, each cut to MAX_GREP_LINE characters. */
export const MAX_GREP_MATCHES = 100;
const MAX_GREP_LINE = 300;
/** The most code points of one line read_file shows; a longer line is cut, so it cannot fill a page. */
const MAX_READ_LINE = 2000;
/** The largest blob read_file loads; a bigger file is refused by the size ls-tree reported. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;
/** The most output grep reads from git; more is "too much output", not a stalled search. */
const GREP_MAX_BUFFER = 32 * 1024 * 1024;
/** A pattern that takes git longer than this is refused, so one call cannot stall the run. */
const GREP_TIMEOUT_MS = 10_000;
/** Room left under MAX_TOOL_RESULT_CHARS for a tool's own last line. */
const BUDGET = MAX_TOOL_RESULT_CHARS - 300;

/** A path the model gave, as a repository path: "./", a leading "/" and a trailing "/" dropped. */
function repoPath(path: string): string {
  const clean = path
    .trim()
    .replace(/^(\.\/|\/)+/, "")
    .replace(/\/+$/, "");
  if (clean.split("/").some((segment) => segment === "..")) {
    throw new ToolError("paths are relative to the repository root and cannot use ..");
  }
  return clean === "." ? "" : clean;
}

const shown = (path: string) => JSON.stringify(cut(oneLine(path), 200));

function listFiles(files: readonly string[], path: string): string {
  const prefix = repoPath(path);
  const under = files.filter((f) => prefix === "" || f === prefix || f.startsWith(`${prefix}/`));
  if (under.length === 0) throw new ToolError(`no files under ${shown(path)}`);
  const where = prefix === "" ? "the repository root" : shown(prefix);
  const lines = under.map(oneLine);
  if (under.length <= MAX_LISTED_FILES && lines.join("\n").length <= BUDGET) {
    return `${count(under.length, "file")} under ${where}:\n${lines.join("\n")}\n`;
  }
  // Too many to name: each directory one level down, with its count, then the files at this level.
  const children = new Map<string, number>();
  for (const file of under) {
    const rest = prefix === "" ? file : file.slice(prefix.length + 1);
    const slash = rest.indexOf("/");
    const child = slash === -1 ? rest : `${rest.slice(0, slash)}/`;
    children.set(child, (children.get(child) ?? 0) + 1);
  }
  const entries = [...children].map(([child, n]) =>
    child.endsWith("/") ? `${oneLine(child)} (${count(n, "file")})` : oneLine(child),
  );
  let text = `${count(under.length, "file")} under ${where}, too many to name; list one of these:\n`;
  for (const [i, entry] of entries.entries()) {
    if (text.length + entry.length > BUDGET) {
      return `${text}\u2026 and ${entries.length - i} more entries\n`;
    }
    text += `${entry}\n`;
  }
  return text;
}

interface ReadInput {
  path: string;
  start_line?: number | undefined;
  end_line?: number | undefined;
}

function readFile(repo: string, blobs: ReadonlyMap<string, TreeBlob>, input: ReadInput): string {
  const path = repoPath(input.path);
  const blob = blobs.get(path);
  if (blob === undefined) {
    throw new ToolError(`no file ${shown(input.path)} at this commit; list_files shows the paths`);
  }
  if (blob.size > MAX_READ_BYTES) {
    throw new ToolError(
      `${shown(path)} is ${blob.size} bytes, over the ${MAX_READ_BYTES}-byte limit for read_file; grep it instead`,
    );
  }
  const result = runGit(repo, ["cat-file", "blob", blob.oid]);
  if (result.status !== 0) throw new GitError(`git cat-file failed for ${blob.oid} in ${repo}`);
  const bytes = result.stdout;
  if (bytes.subarray(0, 8000).includes(0))
    return `${shown(path)} is a binary file of ${bytes.length} bytes\n`;
  const lines = toolText(bytes.toString("utf8")).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const total = lines.length;
  if (total === 0) return `${shown(path)} is empty\n`;
  const start = input.start_line ?? 1;
  if (start > total)
    throw new ToolError(`${shown(path)} has ${total} lines; start_line is past its end`);
  const last = Math.min(input.end_line ?? total, total, start + MAX_READ_LINES - 1);
  if (last < start) throw new ToolError("end_line is before start_line");
  let body = "";
  let end = start - 1;
  for (let n = start; n <= last; n++) {
    const line = `${n}\t${cut(lines[n - 1] ?? "", MAX_READ_LINE)}\n`;
    if (body.length + line.length > BUDGET && n > start) break;
    body += line;
    end = n;
  }
  const more =
    end < total
      ? `\u2026 lines ${end + 1}-${total} not shown; call read_file with start_line ${end + 1} to read on\n`
      : "";
  return `${shown(path)}, lines ${start}-${end} of ${total}:\n${body}${more}`;
}

interface GrepInput {
  pattern: string;
  path?: string | undefined;
  ignore_case?: boolean | undefined;
}

function grep(repo: string, sha: string, input: GrepInput, timeoutMs: number): string {
  const path = repoPath(input.path ?? "");
  // Pinned like the engine's diff calls. Global options come before the command: the path is a path,
  // never a pathspec like ":(glob)*"; attributes come from the commit, not the working tree or a
  // core.attributesFile; and no config (grep.column, submodule.recurse, core.fsmonitor) can reshape
  // the output or run a hook. -I still follows the repository's own .git/info/attributes and a
  // diff driver's binary setting: local settings of the clone, not content of the commit.
  const args = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesFile=/dev/null",
    "--literal-pathspecs",
    `--attr-source=${sha}`,
    "grep",
    "-n",
    "-I",
    "-z",
    "--no-color",
    "--no-column",
    "--no-recurse-submodules",
    "-E",
  ];
  if (input.ignore_case === true) args.push("-i");
  args.push("-e", input.pattern, sha, "--", path === "" ? "." : path);
  const result = runGit(repo, args, timeoutMs, GREP_MAX_BUFFER);
  if (result.error !== undefined && "code" in result.error && result.error.code === "ENOBUFS") {
    throw new ToolError("grep produced too much output; narrow the pattern or the path");
  }
  if (result.signal !== null) {
    throw new ToolError("grep took too long; narrow the pattern or the path");
  }
  // No match is exit 1 with nothing on stderr. Any other message (a partial clone's "unable to
  // read <oid>", say) means files went unsearched, so "No matches." would be a false answer.
  // Warning lines alone do not stop the search from having finished.
  const stderr = result.stderr.toString("utf8");
  const complaints = stderr.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("warning:"));
  if (result.status === 1 && complaints.length === 0) return "No matches.\n";
  if (result.status !== 0) {
    const cause = gitFailureCause(repo, stderr, { unreadableObject: result.status === 1 });
    const why = cause ?? cut(oneLine(stderr).replace(/^fatal: /, ""), 200);
    throw new ToolError(`grep failed: ${why}`);
  }
  // Each match is "<sha>:<path>\0<line>\0<text>\n"; the path may hold any character but NUL.
  const out = result.stdout.toString("utf8");
  const matches: string[] = [];
  let at = 0;
  while (at < out.length && matches.length < MAX_GREP_MATCHES) {
    const pathEnd = out.indexOf("\0", at);
    const lineEnd = out.indexOf("\0", pathEnd + 1);
    const textEnd = out.indexOf("\n", lineEnd + 1);
    if (pathEnd === -1 || lineEnd === -1) break;
    const file = out.slice(at + sha.length + 1, pathEnd);
    const text = out.slice(lineEnd + 1, textEnd === -1 ? out.length : textEnd);
    matches.push(
      `${oneLine(file)}:${out.slice(pathEnd + 1, lineEnd)}: ${cut(oneLine(text), MAX_GREP_LINE)}`,
    );
    at = textEnd === -1 ? out.length : textEnd + 1;
  }
  // Parsing stopped at the cap. Every match ends in a newline and its text cannot hold one (a text
  // may hold a NUL: -I looks only at a file's start), so the matches left are the newlines left.
  let rest = 0;
  for (let end = out.indexOf("\n", at); end !== -1; end = out.indexOf("\n", end + 1)) rest++;
  if (at < out.length && !out.endsWith("\n")) rest++;
  const total = matches.length + rest;
  let body = "";
  let listed = 0;
  for (const match of matches) {
    if (body.length + match.length > BUDGET) break;
    body += `${match}\n`;
    listed++;
  }
  const more =
    listed < total
      ? `\u2026 and ${total - listed} more matches; narrow the pattern or the path\n`
      : "";
  return `${count(total, "matching line")}:\n${body}${more}`;
}

/**
 * The repo agent's tools (spec §9): `list_files`, `read_file` and `grep` over the repository at
 * `sha`, read through git objects only (ls-tree, cat-file, grep on the commit), never the working
 * tree, so the agent sees exactly the code the wiki was built from. A directory inside a
 * repository gives the whole repository. `grepTimeoutMs` (default GREP_TIMEOUT_MS) is how long one
 * grep may run; a test gives a tiny one.
 */
export function createRepoTools(
  repoDir: string,
  sha: string,
  options: { grepTimeoutMs?: number } = {},
): LocalToolSet {
  const grepTimeoutMs = options.grepTimeoutMs ?? GREP_TIMEOUT_MS;
  assertSha(sha);
  const repo = topLevel(repoDir);
  // The engine's listBlobs: regular files at `sha` (symlinks and submodules have no text), sorted.
  const blobs = new Map(listBlobs(repo, sha).map((blob) => [blob.path, blob]));
  const files = [...blobs.keys()];
  return toolSet([
    defineTool(
      "list_files",
      `List the repository's files under a directory (the whole repository when path is empty), one path per line. Over ${MAX_LISTED_FILES} files, it lists the directory's subdirectories with their file counts instead.`,
      z.strictObject({ path: z.string().max(500).optional() }),
      ({ path }) => listFiles(files, path ?? ""),
    ),
    defineTool(
      "read_file",
      `Read a file's lines, numbered, at most ${MAX_READ_LINES} lines per call; start_line and end_line (1-based, inclusive) choose a range.`,
      z.strictObject({
        path: z.string().min(1).max(500),
        start_line: z.int().positive().optional(),
        end_line: z.int().positive().optional(),
      }),
      (input) => readFile(repo, blobs, input),
    ),
    defineTool(
      "grep",
      `Search the files' text with a POSIX extended regular expression; returns up to ${MAX_GREP_MATCHES} matching lines as path:line: text. path limits the search to a file or directory.`,
      z.strictObject({
        pattern: z.string().min(1).max(500),
        path: z.string().max(500).optional(),
        ignore_case: z.boolean().optional(),
      }),
      (input) => grep(repo, sha, input, grepTimeoutMs),
    ),
  ]);
}
