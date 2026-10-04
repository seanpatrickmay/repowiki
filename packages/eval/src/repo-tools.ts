import { spawnSync } from "node:child_process";
import { GitError, scrubbedGitEnv } from "@repowiki/engine";
import { z } from "zod";
import { count, cut, oneLine, toolText } from "./text.ts";
import { defineTool, MAX_TOOL_RESULT_CHARS, ToolError, type ToolSet, toolSet } from "./tools.ts";

/** The most paths list_files names before it summarizes by directory instead. */
export const MAX_LISTED_FILES = 400;
/** The most lines one read_file call returns. */
export const MAX_READ_LINES = 400;
/** The most matching lines one grep call returns, each cut to MAX_GREP_LINE characters. */
export const MAX_GREP_MATCHES = 100;
const MAX_GREP_LINE = 300;
/** A pattern that takes git longer than this is refused, so one call cannot stall the run. */
const GREP_TIMEOUT_MS = 10_000;
/** Room left under MAX_TOOL_RESULT_CHARS for a tool's own last line. */
const BUDGET = MAX_TOOL_RESULT_CHARS - 300;

interface Blob {
  oid: string;
  size: number;
}

/**
 * Runs read-only git in `repo`; the environment cannot point it at another repository. A git that
 * cannot start is a GitError; a timeout is left for the caller to read from `signal`.
 */
function git(repo: string, args: readonly string[], timeout?: number) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    env: scrubbedGitEnv(),
    maxBuffer: 1 << 30,
    timeout,
  });
  if (result.error !== undefined && result.signal === null) {
    throw new GitError(`could not run git: ${result.error.message}`);
  }
  return result;
}

/** Regular files at `sha` (symlinks and submodules have no text to read), by path. */
function listTree(repo: string, sha: string): Map<string, Blob> {
  const result = git(repo, [
    "ls-tree",
    "-r",
    "-z",
    "--long",
    "--full-tree",
    "--end-of-options",
    sha,
  ]);
  if (result.status !== 0) {
    throw new GitError(`git ls-tree failed in ${repo}: ${result.stderr.toString("utf8").trim()}`);
  }
  const blobs = new Map<string, Blob>();
  for (const entry of result.stdout.toString("utf8").split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, oid, size] = entry.slice(0, tab).split(/ +/);
    if (type !== "blob" || mode === "120000" || oid === undefined) continue;
    blobs.set(entry.slice(tab + 1), { oid, size: Number(size) });
  }
  return new Map([...blobs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

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
      return `${text}… and ${entries.length - i} more entries\n`;
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

function readFile(repo: string, blobs: ReadonlyMap<string, Blob>, input: ReadInput): string {
  const path = repoPath(input.path);
  const blob = blobs.get(path);
  if (blob === undefined) {
    throw new ToolError(`no file ${shown(input.path)} at this commit; list_files shows the paths`);
  }
  const result = git(repo, ["cat-file", "blob", blob.oid]);
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
    const line = `${n}\t${lines[n - 1] ?? ""}\n`;
    if (body.length + line.length > BUDGET && n > start) break;
    body += line;
    end = n;
  }
  const more =
    end < total
      ? `… lines ${end + 1}-${total} not shown; call read_file with start_line ${end + 1} to read on\n`
      : "";
  return `${shown(path)}, lines ${start}-${end} of ${total}:\n${body}${more}`;
}

interface GrepInput {
  pattern: string;
  path?: string | undefined;
  ignore_case?: boolean | undefined;
}

function grep(repo: string, sha: string, input: GrepInput): string {
  const path = repoPath(input.path ?? "");
  // A git option, so before the command: the path is a path, never a pathspec like ":(glob)*".
  const args = ["--literal-pathspecs", "grep", "-n", "-I", "-z", "--no-color", "-E"];
  if (input.ignore_case === true) args.push("-i");
  args.push("-e", input.pattern, sha, "--", path === "" ? "." : path);
  const result = git(repo, args, GREP_TIMEOUT_MS);
  if (result.signal !== null) {
    throw new ToolError("grep took too long; narrow the pattern or the path");
  }
  if (result.status === 1) return "No matches.\n";
  if (result.status !== 0) {
    const why = cut(oneLine(result.stderr.toString("utf8")).replace(/^fatal: /, ""), 200);
    throw new ToolError(`grep failed: ${why}`);
  }
  // Each match is "<sha>:<path>\0<line>\0<text>\n"; the path may hold any character but NUL.
  const out = result.stdout.toString("utf8");
  const matches: string[] = [];
  let at = 0;
  while (at < out.length) {
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
  let body = "";
  let listed = 0;
  for (const match of matches.slice(0, MAX_GREP_MATCHES)) {
    if (body.length + match.length > BUDGET) break;
    body += `${match}\n`;
    listed++;
  }
  const more =
    listed < matches.length
      ? `… and ${matches.length - listed} more matches; narrow the pattern or the path\n`
      : "";
  return `${count(matches.length, "matching line")}:\n${body}${more}`;
}

/**
 * The repo agent's tools (spec §9): `list_files`, `read_file` and `grep` over the repository at
 * `sha`, read through git objects only (ls-tree, cat-file, grep on the commit), never the working
 * tree, so the agent sees exactly the code the wiki was built from.
 */
export function createRepoTools(repo: string, sha: string): ToolSet {
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new GitError(`not a 40-hex commit sha: ${JSON.stringify(sha)}`);
  const blobs = listTree(repo, sha);
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
      (input) => grep(repo, sha, input),
    ),
  ]);
}
