import { type GitOptions, indexRepo } from "@repowiki/engine";
import { indexedCount } from "./facts.ts";
import { type TreeTechnologies, treeTechnologies } from "./technologies.ts";

/** The child lists at most this many unread manifests of each kind (review I3). */
export const MAX_LISTED_PATHS = 100;
const MAX_LISTED_LENGTH = 1000;

const listed = (paths: readonly string[]) =>
  paths.filter((p) => p.length <= MAX_LISTED_LENGTH).slice(0, MAX_LISTED_PATHS);

/**
 * What the index child prints (index-child.ts): each indexed file's language, lines and skip
 * reason, and the tree's technologies (ADR-0014). Detection never fails the index: if it throws,
 * the report has no technologies and `warn` gets one line naming the error's class.
 */
export async function indexReport(input: {
  repo: string;
  sha: string;
  git?: GitOptions;
  detect?: typeof treeTechnologies;
  warn?: (line: string) => void;
}) {
  const index = await indexRepo(input.repo, input.sha, input.git ? { git: input.git } : {});
  const files = index.files.map((f) => ({ language: f.language, loc: f.loc, skipped: f.skipped }));
  const imports = index.unresolved
    .filter((u) => u.external)
    .map((u) => ({ from: u.from, specifier: u.specifier }));
  let found: TreeTechnologies;
  try {
    found = await (input.detect ?? treeTechnologies)({
      repo: input.repo,
      sha: input.sha,
      imports,
      ...(input.git ? { git: input.git } : {}),
    });
  } catch (error) {
    input.warn?.(`technology detection failed: ${error instanceof Error ? error.name : "unknown"}`);
    found = { technologies: [], unparsed: [], tooLarge: [] };
  }
  return {
    indexed: indexedCount(files),
    files,
    technologies: found.technologies,
    unparsed: listed(found.unparsed),
    tooLarge: listed(found.tooLarge),
  };
}
