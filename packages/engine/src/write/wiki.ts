import type { Manifest, Revision } from "@repowiki/core";
import type { BatchJournal, FetchLike } from "@repowiki/llm";
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
  /** The provider's batch journal, flushed in the transaction that stores the pages. */
  journal?: BuildJournal;
}

/** A batch journal whose forgets wait for flush(). */
export interface BuildJournal extends BatchJournal {
  /** Names the page a batched request belongs to (the Claude provider's onBatchRequest). */
  tag(requestKey: string, featureId: string | null): void;
  /**
   * Forgets the collected requests of every page all of whose requests were answered; a page
   * with a request still unanswered keeps every row.
   */
  flush(): void;
}

/**
 * The store's batch journal for a build. The batcher forgets a request once its answer is read,
 * but the answer is only safe once its page is stored: until then a killed build must leave the
 * row, so a rerun collects the batch instead of paying for it again. So forgets are held in
 * memory until buildWiki flushes them in the transaction that settles the pages, written or not
 * (a failed page's rows are forgotten too, or a rerun would replay the same failing answer).
 *
 * A page whose round-1 or retry batch failed as a whole (canceled at its deadline, or its results
 * never downloaded) settled from no answer: the batcher forgot nothing for that request, and its
 * page keeps every row, round 1's included, so a rerun rebuilds the same requests and collects
 * both batches. Requests no tag names are forgotten as before.
 */
export function buildJournal(store: Store): BuildJournal {
  const pending = new Map<string, Set<string>>();
  const pages = new Map<string, Set<string>>();
  return {
    lookup: (key) => store.findBatchRequest(key),
    record: (batchId, createdAt, items) => store.recordBatchRequests(batchId, createdAt, items),
    forget: (batchId, keys) => {
      const batch = pending.get(batchId) ?? new Set();
      for (const key of keys) batch.add(key);
      pending.set(batchId, batch);
    },
    tag: (key, featureId) => {
      if (featureId === null) return;
      pages.set(featureId, (pages.get(featureId) ?? new Set()).add(key));
    },
    flush: () => {
      const answered = new Set([...pending.values()].flatMap((keys) => [...keys]));
      const kept = new Set(
        [...pages.values()].flatMap((keys) =>
          [...keys].every((key) => answered.has(key)) ? [] : [...keys],
        ),
      );
      try {
        for (const [batchId, keys] of pending) {
          const forgotten = [...keys].filter((key) => !kept.has(key));
          for (const key of forgotten) keys.delete(key);
          store.forgetBatchRequests(batchId, forgotten);
        }
      } catch {
        // A row left behind only costs a replay; it must never roll back the pages it answers.
      }
    },
  };
}

export interface WikiBuild {
  /** The stored manifest, with code-identifier aliases added. */
  manifest: Manifest;
  /**
   * The code aliases found this run, per feature. A rerun may find fewer (see codeAliases); the
   * stored manifest keeps every alias already added.
   */
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
  const atSha = store.getManifest(index.sha);
  if (atSha === null) {
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
  const aliases = codeAliases(atSha, input.sources);
  const manifest = store.amendManifestAliases(index.sha, aliases);
  const missing = manifest.features
    .filter((f) => f.status.kind === "active" && store.getCurrentRevision(f.id) === null)
    .map((f) => f.id);
  if (missing.length === 0) return { manifest, aliases, stored: [], written: null };

  const { wikipediaFetch, journal, ...rest } = options;
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
    // Every page failed; its answers are settled all the same.
    store.transaction(() => journal?.flush());
    throw new WikiBuildError(
      `no page could be written: ${written.pages.map((p) => `${p.featureId}: ${p.failure}`).join("; ")}`,
    );
  }
  store.transaction(() => {
    for (const revision of revisions) store.putRevision(revision);
    store.setHead(index.sha);
    journal?.flush();
  });
  return { manifest, aliases, stored: revisions, written };
}
