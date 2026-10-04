import { memberId } from "@repowiki/core";
import type { CoChangePair, ImportEdge, RepoIndex } from "../index/index.ts";

/** A hand-built RepoIndex: file-level files only, with the given edges. Test-only. */
export function makeIndex(
  paths: readonly string[],
  edges: { imports?: [string, string][]; coChange?: [string, string, number][] } = {},
): RepoIndex {
  const imports: ImportEdge[] = (edges.imports ?? []).map(([from, to]) => ({ from, to, line: 1 }));
  const pairs: CoChangePair[] = (edges.coChange ?? []).map(([a, b, count]) => ({ a, b, count }));
  const fileCommits: Record<string, number> = {};
  for (const { a, b, count } of pairs) {
    fileCommits[a] = Math.max(fileCommits[a] ?? 0, count);
    fileCommits[b] = Math.max(fileCommits[b] ?? 0, count);
  }
  return {
    sha: "a".repeat(40),
    files: [...paths].sort().map((path) => ({
      id: memberId(path),
      path,
      language: null,
      bytes: 1,
      loc: 1,
      skipped: null,
      parseError: false,
      symbols: [],
    })),
    imports,
    unresolved: [],
    coChange: { commitsConsidered: pairs.length, commitsSkipped: 0, fileCommits, pairs },
    invalidPaths: [],
  };
}
