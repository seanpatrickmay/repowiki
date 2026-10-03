import type { Manifest, Revision } from "@repowiki/core";
import type { BatchJournal, FetchLike } from "@repowiki/llm";
import { codeAliases, type WikipediaOptions } from "../link/index.ts";
import type { Store } from "../store/index.ts";
import { type ArchitectureOutcome, writeArchitecture } from "./architecture.ts";
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
  /**
   * The provider's batch journal, flushed in the transaction that stores the pages, and again in
   * the one that stores the project's article.
   */
  journal?: BuildJournal;
  /** The project article's pack budget (default DEFAULT_ARCHITECTURE_BUDGET_TOKENS). */
  architectureBudgetTokens?: number;
}

/** Fewer feature pages than this leave nothing to fit together: no project article. */
export const MIN_ARCHITECTURE_PAGES = 2;

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
  /** The project article's round, or null when it made no call (see `architectureSkipped`). */
  architecture: ArchitectureOutcome | null;
  /**
   * Why there was no call for the project's article: "current" when the stored one was written
   * at this sha from exactly the current pages, "too few pages" below MIN_ARCHITECTURE_PAGES;
   * null when the round ran.
   */
  architectureSkipped: "current" | "too few pages" | null;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The first full build of a repository at index.sha (spec §4 data flow: write → verify → link →
 * store, then the project's article): adds code-identifier aliases to the stored manifest, writes
 * every active feature's page, and stores the pages and the head in one transaction. Then it
 * writes the project's article (the Architecture article, spec §7.4) from the stored pages in its
 * own round and stores it; a failed article is reported and never undoes the pages. A rerun at
 * the same sha writes only the pages that are missing (a page that failed, or one a crash never
 * stored), and rewrites the article (a new revision, parented on the old) only if it is missing or
 * the set of current pages changed; a finished rerun makes no LLM call. A store already built at
 * another sha needs an update (M6), so this refuses.
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
  const active = manifest.features.filter((f) => f.status.kind === "active");
  const missing = active.filter((f) => store.getCurrentRevision(f.id) === null).map((f) => f.id);

  const { wikipediaFetch, journal, architectureBudgetTokens, ...rest } = options;
  const wikipedia: WikipediaOptions = {
    cache: {
      get: (title) => store.getWikipediaSummary(title),
      put: (title, summary, at) => store.putWikipediaSummary(title, summary, at),
    },
    ...(wikipediaFetch === undefined ? {} : { fetch: wikipediaFetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  let written: WrittenPages | null = null;
  let stored: Revision[] = [];
  if (missing.length > 0) {
    written = await writePages({ ...input, manifest, only: missing }, { ...rest, wikipedia });
    stored = written.pages.flatMap((page) => (page.revision === null ? [] : [page.revision]));
    if (stored.length === 0) {
      // Every page failed; its answers are settled all the same.
      store.transaction(() => journal?.flush());
      throw new WikiBuildError(
        `no page could be written: ${written.pages.map((p) => `${p.featureId}: ${p.failure}`).join("; ")}`,
      );
    }
    store.transaction(() => {
      for (const revision of stored) store.putRevision(revision);
      store.setHead(index.sha);
      journal?.flush();
    });
  }
  const done = { manifest, aliases, stored, written };

  const pages = active.flatMap((f) => store.getCurrentRevision(f.id) ?? []);
  if (pages.length < MIN_ARCHITECTURE_PAGES) {
    return { ...done, architecture: null, architectureSkipped: "too few pages" };
  }
  const current = store.getCurrentArchitecture();
  const basis = pages.map((p) => p.id).sort();
  if (current !== null && current.sha === index.sha && sameList(current.basis, basis)) {
    return { ...done, architecture: null, architectureSkipped: "current" };
  }
  const architecture = await writeArchitecture(
    {
      index,
      manifest,
      sources: input.sources,
      history: input.history,
      pages,
      parent: current,
      number: store.listArchitectureHistory().length + 1,
    },
    {
      provider: options.provider,
      repoName: options.repoName,
      wikipedia,
      ...(options.batch === undefined ? {} : { batch: options.batch }),
      ...(architectureBudgetTokens === undefined ? {} : { budgetTokens: architectureBudgetTokens }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.log === undefined ? {} : { log: options.log }),
    },
  );
  // The article's call is untagged, so this flush forgets its journal rows once it is settled.
  store.transaction(() => {
    if (architecture.architecture !== null) store.putArchitecture(architecture.architecture);
    journal?.flush();
  });
  return { ...done, architecture, architectureSkipped: null };
}
