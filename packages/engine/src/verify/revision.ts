import { contentHash, type Revision } from "@repowiki/core";
import { citedLines } from "./claims.ts";
import { diagramProblems } from "./diagram.ts";

/**
 * Re-checks a stored revision against the files of its sha (spec §8's first replay invariant):
 * every code citation names a file whose cited lines still hash to its contentHash at the
 * citation's own sha, and the diagram is safe. `sourcesAt(sha)` gives the readable files at a sha;
 * it is called once per distinct sha, and a sha it throws for (a commit the repository no longer
 * holds) is reported against each citation at it rather than thrown.
 */
export function revisionProblems(
  revision: Revision,
  sourcesAt: (sha: string) => ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  const cache = new Map<string, ReadonlyMap<string, string> | null>();
  const sourcesOf = (sha: string): ReadonlyMap<string, string> | null => {
    if (!cache.has(sha)) {
      try {
        cache.set(sha, sourcesAt(sha));
      } catch {
        cache.set(sha, null);
      }
    }
    return cache.get(sha) ?? null;
  };
  for (const section of revision.sections) {
    for (const claim of section.claims) {
      for (const citation of claim.citations) {
        if (citation.kind !== "code") continue;
        const where = `${revision.featureId} ${claim.id} ${citation.path}:${citation.startLine}-${citation.endLine}`;
        const sources = sourcesOf(citation.sha);
        if (sources === null) {
          problems.push(`${where}: no such commit ${citation.sha}`);
          continue;
        }
        const text = sources.get(citation.path);
        if (text === undefined) {
          problems.push(`${where}: no such file at ${citation.sha.slice(0, 7)}`);
          continue;
        }
        const hash = contentHash(citedLines(text, citation.startLine, citation.endLine));
        if (hash !== citation.contentHash) problems.push(`${where}: the cited lines changed`);
      }
    }
  }
  if (revision.diagram !== null) {
    for (const problem of diagramProblems(revision.diagram)) {
      problems.push(`${revision.featureId}: ${problem}`);
    }
  }
  return problems;
}
