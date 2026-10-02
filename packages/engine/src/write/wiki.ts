import type { Manifest, Revision } from "@repowiki/core";
import type { FetchLike } from "@repowiki/llm";
import { codeAliases } from "../link/index.ts";
import type { Store } from "../store/index.ts";
import {
  type WritePagesInput,
  type WritePagesOptions,
  type WrittenPages,
  writePages,
} from "./build.ts";

export class WikiBuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface WikiBuildOptions extends Omit<WritePagesOptions, "wikipedia"> {
  /** Replaces global fetch for Wikipedia lookups, e.g. with a cassette in tests. */
  wikipediaFetch?: FetchLike;
}

export interface WikiBuild {
  /** The stored manifest, with code-identifier aliases added. */
  manifest: Manifest;
  /** The aliases added this run, per feature. */
  aliases: Record<string, string[]>;
  /** Pages written and stored this run, sorted by feature id; empty when every page existed. */
  stored: Revision[];
  /** Null when no page needed writing. */
  written: WrittenPages | null;
}

/**
 * The first full build of a repository at index.sha (spec §4 data flow: write → verify → link →
 * store): adds code-identifier aliases to the stored manifest, writes every active feature's page,
 * and stores the pages and the head in one transaction. A rerun at the same sha writes only the
 * pages that are missing (a page that failed, or one a crash never stored) and makes no LLM call
 * when none is. A store already built at another sha needs an update (M6), so this refuses.
 */
export async function buildWiki(
  store: Store,
  input: Omit<WritePagesInput, "manifest" | "only">,
  options: WikiBuildOptions,
): Promise<WikiBuild> {
  const { index } = input;
  const stored = store.getManifest(index.sha);
  if (stored === null) {
    throw new WikiBuildError(
      `the store has no manifest for ${index.sha}; run manifest:build first`,
    );
  }
  const head = store.getHead();
  if (head !== null && head !== index.sha) {
    throw new WikiBuildError(
      `the wiki was built at ${head}; moving it to ${index.sha} is an update, not a build`,
    );
  }
  const aliases = codeAliases(stored, input.sources);
  const manifest = store.amendManifestAliases(index.sha, aliases);
  const missing = manifest.features
    .filter((f) => f.status.kind === "active" && store.getCurrentRevision(f.id) === null)
    .map((f) => f.id);
  if (missing.length === 0) return { manifest, aliases, stored: [], written: null };

  const { wikipediaFetch, ...rest } = options;
  const written = await writePages(
    { ...input, manifest, only: missing },
    {
      ...rest,
      wikipedia: {
        cache: {
          get: (title) => store.getWikipediaSummary(title),
          put: (title, summary, at) => store.putWikipediaSummary(title, summary, at),
        },
        ...(wikipediaFetch === undefined ? {} : { fetch: wikipediaFetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    },
  );
  const revisions = written.pages.flatMap((page) =>
    page.revision === null ? [] : [page.revision],
  );
  if (revisions.length === 0) {
    throw new WikiBuildError(
      `no page could be written: ${written.pages.map((p) => `${p.featureId}: ${p.failure}`).join("; ")}`,
    );
  }
  store.transaction(() => {
    for (const revision of revisions) store.putRevision(revision);
    store.setHead(index.sha);
  });
  return { manifest, aliases, stored: revisions, written };
}
