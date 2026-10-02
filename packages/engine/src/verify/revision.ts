import { contentHash, type Revision } from "@repowiki/core";
import { citedLines } from "./claims.ts";
import { diagramProblems } from "./diagram.ts";

/**
 * Re-checks a stored revision against the files of its sha (spec §8's first replay invariant):
 * every code citation names a file whose cited lines still hash to its contentHash, and the
 * diagram is safe. `sourcesAt(sha)` gives the readable files at a sha.
 */
export function revisionProblems(
  revision: Revision,
  sourcesAt: (sha: string) => ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  for (const section of revision.sections) {
    for (const claim of section.claims) {
      for (const citation of claim.citations) {
        if (citation.kind !== "code") continue;
        const where = `${revision.featureId} ${claim.id} ${citation.path}:${citation.startLine}-${citation.endLine}`;
        const text = sourcesAt(citation.sha).get(citation.path);
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
