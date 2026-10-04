import { memberId } from "@repowiki/core";
import { SHA_B } from "@repowiki/core/test-fixtures";
import type { IndexedFile, RepoIndex } from "../index/index.ts";

/** One indexed file: a path and its top-level symbols as [name, start, end, exported?]. */
export function indexedFile(
  path: string,
  symbols: [string, number, number, boolean?][] = [],
): IndexedFile {
  const language = path.endsWith(".py") ? "python" : path.endsWith(".ts") ? "typescript" : null;
  return {
    id: memberId(path),
    path,
    language,
    bytes: 100,
    loc: 10,
    skipped: null,
    parseError: false,
    symbols: symbols.map(([qualifiedName, startLine, endLine, exported = true]) => ({
      id: memberId(path, qualifiedName),
      qualifiedName,
      kind: "function",
      startLine,
      endLine,
      exported,
    })),
  };
}

/** A RepoIndex at SHA_B over `files`, with import edges and co-changed pairs. Test-only. */
export function indexOf(
  files: IndexedFile[],
  imports: [string, string][] = [],
  together: [string, string, number][] = [],
): RepoIndex {
  return {
    sha: SHA_B,
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
    imports: imports.map(([from, to]) => ({ from, to, line: 1 })),
    calls: [],
    invalidPaths: [],
    unresolved: [],
    coChange: {
      commitsConsidered: 1,
      commitsSkipped: 0,
      fileCommits: {},
      pairs: together.map(([a, b, count]) => (a < b ? { a, b, count } : { a: b, b: a, count })),
    },
  };
}
