import { type GitOptions, listBlobs, readSources } from "@repowiki/engine";
import { detectTechnologies, sourcePaths, type TechnologyUse } from "@repowiki/hosted";

/** Production reads at most this many manifest and compose files, each at most this big (ADR-0014). */
export const MAX_SOURCE_FILES = 100;
export const MAX_SOURCE_BYTES = 128 * 1024;

export interface TreeTechnologies {
  technologies: TechnologyUse[];
  /** Manifests that would not parse; they contributed nothing. */
  unparsed: string[];
  /** Manifests over the size limit, never read. */
  tooLarge: string[];
}

/**
 * The technologies of the tree at `sha` (ADR-0014): its paths, the contents of its manifest and
 * compose files (shallowest first, within the limits) and the index's external imports, or null
 * when there is no index.
 */
export async function treeTechnologies(input: {
  repo: string;
  sha: string;
  imports: readonly { from: string; specifier: string }[] | null;
  git?: GitOptions;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<TreeTechnologies> {
  const maxBytes = input.maxBytes ?? MAX_SOURCE_BYTES;
  const blobs = listBlobs(input.repo, input.sha, input.git);
  const size = new Map(blobs.map((b) => [b.path, b.size]));
  const paths = blobs.map((b) => b.path);
  const wanted = sourcePaths(paths, Number.POSITIVE_INFINITY);
  const tooLarge = wanted.filter((p) => (size.get(p) ?? 0) > maxBytes);
  const skipped = new Set(tooLarge);
  const read = wanted.filter((p) => !skipped.has(p)).slice(0, input.maxFiles ?? MAX_SOURCE_FILES);
  const sources =
    read.length === 0
      ? new Map<string, string>()
      : await readSources(input.repo, input.sha, maxBytes, { ...input.git, only: new Set(read) });
  const { technologies, unparsed } = detectTechnologies({ paths, sources, imports: input.imports });
  return { technologies, unparsed, tooLarge };
}
