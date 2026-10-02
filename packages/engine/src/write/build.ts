import { createHash } from "node:crypto";
import type { Manifest, Revision, SectionKey, TokenUsage } from "@repowiki/core";
import { type GenerateResult, LlmOutputError, type Provider } from "@repowiki/llm";
import { buildFileGraph, type FileGraph } from "../cluster/index.ts";
import type { CommitInfo, RepoIndex } from "../index/index.ts";
import {
  checkWikipediaTitles,
  featureNeighbours,
  type WikipediaCheck,
  type WikipediaOptions,
  wikipediaTitlesIn,
} from "../link/index.ts";
import { PageDraft, quote, type VerifyContext } from "../verify/index.ts";
import { buildPack, type ContextPack, DEFAULT_CONTEXT_BUDGET_TOKENS } from "./pack.ts";
import { type Assembled, assembleRevision } from "./page.ts";
import { writeSystemPrompt } from "./prompt.ts";
import { newPageState, type PageState, uniqueClaims, uniqueDraft, verifyAll } from "./rounds.ts";

export interface WritePagesInput {
  index: RepoIndex;
  manifest: Manifest;
  /** Text of every readable file at index.sha. */
  sources: ReadonlyMap<string, string>;
  /** Every commit reachable from index.sha, newest first. */
  history: readonly CommitInfo[];
  /** The file graph the manifest was clustered from; rebuilt from the index when absent. */
  graph?: FileGraph;
  /** Write only these features' pages (default: every active feature). */
  only?: readonly string[];
}

export interface WritePagesOptions {
  provider: Provider;
  repoName: string;
  /** Use the Message Batches API (half price). Default true: no one waits on a build. */
  batch?: boolean;
  /** Per-page context budget (spec §7.2: contextBudgetTokens). Default 30,000. */
  budgetTokens?: number;
  wikipedia: WikipediaOptions;
  now?: () => Date;
  /** Receives one line per dropped claim, failed page and unreachable Wikipedia title. */
  log?: (line: string) => void;
}

/** What happened to one feature's page. */
export interface PageOutcome {
  featureId: string;
  /** Null when the page could not be written (see `failure`). */
  revision: Revision | null;
  failure: string | null;
  /** Claims dropped after failing verification twice, with the problems of the last attempt. */
  dropped: { section: SectionKey; text: string; problems: string[] }[];
  /** Write calls the model answered for the page: 1, or 2 with a retry. */
  calls: number;
}

export interface WrittenPages {
  pages: PageOutcome[];
  packs: ContextPack[];
  wikipedia: WikipediaCheck;
  /** The prefix every page's first call shares, and its cache key. */
  system: string;
  cacheKey: string;
}

/** Longest answer a page may take; the prototype's pages used 2-5K output tokens. */
export const MAX_PAGE_OUTPUT_TOKENS = 8000;

/** The write calls' cacheKey: the sha plus a hash of the shared prefix (see manifestCacheKey). */
export function writeCacheKey(sha: string, system: string): string {
  return `write-${sha}-${createHash("sha256").update(system).digest("hex").slice(0, 12)}`;
}

const addTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  in: a.in + b.in,
  out: a.out + b.out,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

type Settled<T> = { result: GenerateResult<T> } | { error: unknown };
const settle = <T>(promise: Promise<GenerateResult<T>>): Promise<Settled<T>> =>
  promise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );

/** The name of whatever was thrown: never its message, which may hold model text. */
const errorClass = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : typeof error;

/**
 * Writes every active feature's page (spec §7): one write call per page, all issued in the same
 * tick so they share one Message Batch. A claim that fails verification is dropped and logged,
 * and a page whose answer is unusable or left without a lead or a body is not written (the retry
 * round of spec §6.3 comes next). Links are resolved
 * after verification, Wikipedia titles checked through the cache, and each page gets its
 * infobox, diagram and See also. Nothing here touches the store.
 */
export async function writePages(
  input: WritePagesInput,
  options: WritePagesOptions,
): Promise<WrittenPages> {
  const { index, manifest, sources, history } = input;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const batch = options.batch ?? true;
  const graph = input.graph ?? buildFileGraph(index);
  const neighbours = featureNeighbours(graph, manifest);
  const symbols = new Map(index.files.map((f) => [f.path, f.symbols]));
  const ctx: VerifyContext = {
    sha: index.sha,
    sources,
    symbolsOf: (path) => symbols.get(path) ?? [],
    commits: history,
  };
  const system = writeSystemPrompt(options.repoName, manifest);
  const cacheKey = writeCacheKey(index.sha, system);
  const only = input.only === undefined ? null : new Set(input.only);
  const features = manifest.features
    .filter((f) => f.status.kind === "active" && (only === null || only.has(f.id)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Every pack is built before the first call: the batcher only groups calls made in one tick.
  const packs = features.map((feature) =>
    buildPack({
      featureId: feature.id,
      manifest,
      index,
      sources,
      history,
      neighbours: neighbours.get(feature.id) ?? new Map(),
      budgetTokens: options.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
    }),
  );
  const states = packs.map(newPageState);
  /**
   * Counts an answered call: a result, or an answer the provider could not use. A call that never
   * got an answer (a failed batch, a network error) is not counted. An unusable answer's tokens
   * are in the provider's ledger but not on the error, so the page's tokens miss them.
   */
  const record = (state: PageState, outcome: Settled<unknown>) => {
    if ("result" in outcome) {
      state.calls += 1;
      state.tokens = addTokens(state.tokens, outcome.result.usage);
      state.model ??= outcome.result.model;
    } else if (outcome.error instanceof LlmOutputError) {
      state.calls += 1;
    }
  };

  // Round 1: one call per page, all issued by this one synchronous map.
  const first = await Promise.all(
    states.map((state) =>
      settle(
        options.provider.generate({
          purpose: "write",
          featureId: state.pack.featureId,
          system,
          messages: [{ role: "user", content: state.pack.text }],
          schema: PageDraft,
          maxTokens: MAX_PAGE_OUTPUT_TOKENS,
          cacheKey,
          batch,
        }),
      ),
    ),
  );
  first.forEach((outcome, i) => {
    const state = states[i] as PageState;
    record(state, outcome);
    if ("result" in outcome) {
      // The draft is kept with the page's unique ids, the ones every later turn names.
      const draft = uniqueDraft(outcome.result.output);
      const claims = uniqueClaims(draft);
      const hasLead = claims.some((c) => c.key === "lead");
      if (!hasLead || claims.every((c) => c.key === "lead")) {
        // Nothing to verify claim by claim: ask again for the whole page.
        const reason = "the answer needs at least one lead claim and one body claim";
        state.rejected = { text: JSON.stringify(outcome.result.output), reason };
        return;
      }
      state.draft = draft;
      verifyAll(state, claims, ctx);
    } else if (outcome.error instanceof LlmOutputError) {
      state.rejected = { text: outcome.error.text, reason: outcome.error.message };
    } else {
      state.failure = `the write call failed: ${String(outcome.error)}`;
    }
  });

  // Wikipedia titles of every surviving claim, checked once for the whole run.
  const wikipedia = await checkWikipediaTitles(
    states.flatMap((s) =>
      [...s.verified.values()].flatMap(({ claim }) => wikipediaTitlesIn(claim.text)),
    ),
    options.wikipedia,
  );
  for (const title of wikipedia.failed)
    log(`Wikipedia could not be reached for ${quote(title)}; left as plain text`);

  const commitDate = history.find((c) => c.sha === index.sha)?.date;
  const pages = states.map((state): PageOutcome => {
    const featureId = state.pack.featureId;
    const dropped = [...state.failing.values()].map(({ key, claim, problems }) => ({
      section: key,
      text: claim.text,
      problems,
    }));
    for (const d of dropped)
      log(`${featureId}: dropped a ${d.section} claim: ${d.problems.join("; ")}`);
    const base = { featureId, dropped, calls: state.calls };
    let assembled: Assembled;
    if (state.failure !== null || state.draft === null) {
      assembled = {
        revision: null,
        failure: state.failure ?? "the write call returned no usable page",
      };
    } else {
      try {
        assembled = assembleRevision({
          featureId,
          index,
          manifest,
          commitDate: commitDate ?? now().toISOString(),
          generatedAt: now().toISOString(),
          model: state.model ?? "unknown",
          tokens: state.tokens,
          claims: [...state.verified.values()],
          diagram: state.draft.diagram,
          pack: state.pack,
          neighbours,
          wikipedia: wikipedia.links,
        });
      } catch (error) {
        // One page's unexpected error fails that page only; its message may hold model text.
        assembled = { revision: null, failure: `assembling the page failed: ${errorClass(error)}` };
      }
    }
    if (assembled.revision === null) {
      log(`${featureId}: not written: ${assembled.failure}`);
      return { ...base, revision: null, failure: assembled.failure };
    }
    for (const problem of assembled.diagramProblems)
      log(`${featureId}: diagram refused: ${problem}`);
    return { ...base, revision: assembled.revision, failure: null };
  });
  return { pages, packs, wikipedia, system, cacheKey };
}
