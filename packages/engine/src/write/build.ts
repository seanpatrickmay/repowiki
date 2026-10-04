import { createHash } from "node:crypto";
import {
  type Claim,
  IsoDateTime,
  type Manifest,
  type Revision,
  type SectionKey,
  type TokenUsage,
} from "@repowiki/core";
import {
  CassetteMissError,
  type GenerateRequest,
  type GenerateResult,
  LlmError,
  type LlmMessage,
  LlmOutputError,
  type Provider,
} from "@repowiki/llm";
import { buildFileGraph, type FileGraph } from "../cluster/index.ts";
import type { CommitInfo, RepoIndex } from "../index/index.ts";
import {
  checkWikipediaTitles,
  featureNeighbours,
  normalizeWikipediaTitle,
  type WikipediaCheck,
  type WikipediaOptions,
  wikipediaTitlesIn,
} from "../link/index.ts";
import { ClaimFixes, PageDraft, quote, type VerifyContext } from "../verify/index.ts";
import { buildPack, type ContextPack, DEFAULT_CONTEXT_BUDGET_TOKENS } from "./pack.ts";
import { type Assembled, assembleRevision } from "./page.ts";
import { writeSystemPrompt } from "./prompt.ts";
import {
  fixRequest,
  newPageState,
  type PageState,
  retryRequest,
  setAsideUnfixable,
  uniqueClaims,
  uniqueDraft,
  verifyAll,
} from "./rounds.ts";

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
  /**
   * History claims a feature's new page carries forward, as stored, from the pages it continues
   * (spec §5 rule 4: History is append-only). They go ahead of the page's new History claims;
   * a new one that cites exactly the commits of a carried one is dropped.
   */
  carry?: ReadonlyMap<string, readonly Claim[]>;
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
  /**
   * True when `failure` is a call or batch that failed (a provider error, after the SDK's
   * retries), false or absent for a page the model's answers could not give: an unusable answer, twice.
   */
  callFailed?: boolean;
  /** Claims dropped for failing verification, with the problems of the last attempt. */
  dropped: { section: SectionKey; text: string; problems: string[] }[];
  /** Write calls the model answered for the page: 1, or 2 with a retry. */
  calls: number;
  /** Tokens of those answered calls, an unusable answer's included. */
  tokens: TokenUsage;
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
const MAX_FIX_OUTPUT_TOKENS = 4000;

/** The write calls' cacheKey: the sha plus a hash of the shared prefix (see manifestCacheKey). */
export function writeCacheKey(sha: string, system: string): string {
  return `write-${sha}-${createHash("sha256").update(system).digest("hex").slice(0, 12)}`;
}

export const addTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  in: a.in + b.in,
  out: a.out + b.out,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

export type Settled<T> = { result: GenerateResult<T> } | { error: unknown };
/** A round-2 answer: a whole page again, or fixes for the failing claims. */
type RetryAnswer =
  | { kind: "page"; outcome: Settled<PageDraft> }
  | { kind: "fixes"; outcome: Settled<ClaimFixes> };
export const settle = <T>(promise: Promise<GenerateResult<T>>): Promise<Settled<T>> =>
  promise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );

/** What a round's calls add up to: the calls answered, their tokens, and the model that answered. */
export interface CallTally {
  tokens: TokenUsage;
  model: string | null;
  calls: number;
}

/**
 * Counts an answered call into `tally`: a result, or an answer the provider could not use. A call
 * that never got an answer (a failed batch, a network error) is not counted. An unusable answer's
 * tokens are on the error (the provider's ledger has them too), so the tally agrees with it.
 */
export function recordCall(tally: CallTally, settled: Settled<unknown>): void {
  if ("result" in settled) {
    tally.calls += 1;
    tally.tokens = addTokens(tally.tokens, settled.result.usage);
    tally.model ??= settled.result.model;
  } else if (settled.error instanceof LlmOutputError) {
    tally.calls += 1;
    if (settled.error.usage !== undefined) {
      tally.tokens = addTokens(tally.tokens, settled.error.usage);
    }
    tally.model ??= settled.error.model ?? null;
  }
}

/** The name of whatever was thrown: never its message, which may hold model text. */
export const errorClass = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : typeof error;

/**
 * A failed call as one line: the error class, and the message only of an LlmError, whose messages
 * RepoWiki writes itself. Any other error may carry a provider's response body.
 */
export const callFailure = (error: unknown): string =>
  error instanceof LlmError ? `${errorClass(error)}: ${error.message}` : errorClass(error);

/**
 * Checks Wikipedia titles once for a round of claims. A check that throws leaves every title as
 * plain text for this run (no link without a check) and loses no answer; a missing cassette is a
 * test setup error and is thrown. Each unreachable title is logged.
 */
export async function checkTitles(
  titles: readonly string[],
  options: WikipediaOptions,
  log: (line: string) => void,
): Promise<WikipediaCheck> {
  let wikipedia: WikipediaCheck;
  try {
    wikipedia = await checkWikipediaTitles(titles, options);
  } catch (error) {
    // A missing cassette is a test setup error: replay must fail loudly, never fall back.
    if (error instanceof CassetteMissError) throw error;
    // No link without a check: every title stays plain text this run, and no answer is lost.
    log(`Wikipedia could not be checked (${errorClass(error)}); left as plain text`);
    const wanted = new Set(titles.map(normalizeWikipediaTitle).filter((t) => t !== ""));
    wikipedia = {
      links: new Map([...wanted].sort().map((t) => [t, null])),
      fetched: 0,
      failed: [],
    };
  }
  for (const title of wikipedia.failed)
    log(`Wikipedia could not be reached for ${quote(title)}; left as plain text`);
  return wikipedia;
}

/** The commits a claim cites, as one comparable key. */
const commitsOf = (claim: Claim): string =>
  claim.citations
    .flatMap((c) => (c.kind === "commit" ? [c.sha] : []))
    .sort()
    .join(" ");

/**
 * A page's verified claims with `carried` History claims ahead of its new ones (spec §5 rule 4).
 * A new History claim citing exactly the commits of a carried one is dropped, and a lead claim
 * that summarized it summarizes the carried one instead. Carried claims take draft ids no
 * verified claim uses; the page's own numbering replaces every id anyway.
 */
function withCarried(
  verified: readonly { key: SectionKey; claim: Claim }[],
  carried: readonly Claim[],
): { key: SectionKey; claim: Claim }[] {
  if (carried.length === 0) return [...verified];
  const used = new Set(verified.map((v) => v.claim.id));
  let n = 0;
  const fresh = (): string => {
    let id: string;
    do id = `carried-${++n}`;
    while (used.has(id));
    return id;
  };
  const kept = carried.map((claim) => ({
    key: "history" as const,
    claim: { ...claim, id: fresh() },
  }));
  const byCommits = new Map(kept.map((k) => [commitsOf(k.claim), k.claim.id]));
  const replaced = new Map<string, string>();
  for (const { key, claim } of verified) {
    const same = key === "history" ? byCommits.get(commitsOf(claim)) : undefined;
    if (same !== undefined) replaced.set(claim.id, same);
  }
  const rest = verified
    .filter((v) => !(v.key === "history" && replaced.has(v.claim.id)))
    .map((v) =>
      v.key === "lead" && replaced.size > 0
        ? {
            ...v,
            claim: { ...v.claim, supports: v.claim.supports.map((s) => replaced.get(s) ?? s) },
          }
        : v,
    );
  return [...kept, ...rest];
}

/**
 * Writes every active feature's page (spec §7): one write call per page, all issued in the same
 * tick so they share one Message Batch, then one retry round, also one batch, for pages whose
 * answer was unusable or had claims that failed verification. A claim that fails twice is
 * dropped and logged, and so is a limitation claim that only lacks evidence, without a retry. A
 * page whose retry call fails, or that is left without a lead or a body, is not written. Links
 * are resolved after verification, the Wikipedia titles of the pages still being written are
 * checked through the cache, and each page gets its infobox, diagram and See also. An unexpected
 * error while verifying or assembling one page fails that page only, and a Wikipedia check that
 * throws leaves every Wikipedia link as plain text; neither loses the paid-for answers. Nothing
 * here touches the store.
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
    recordCall(state, outcome);
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
      try {
        verifyAll(state, claims, ctx);
        setAsideUnfixable(state);
      } catch (error) {
        // One page's unexpected error fails that page only; its message may hold model text.
        state.failure = `verifying the claims failed: ${errorClass(error)}`;
      }
    } else if (outcome.error instanceof LlmOutputError) {
      state.rejected = { text: outcome.error.text, reason: outcome.error.message };
    } else {
      state.failure = `the write call failed: ${callFailure(outcome.error)}`;
      state.callFailed = true;
    }
  });

  // Round 2: one retry per page that needs one, all issued by this one synchronous map after
  // every first answer is verified (spec §6.3: retry once). No cacheKey: another schema.
  const retrying = states.filter(
    (s) => s.failure === null && (s.rejected !== null || s.failing.size > 0),
  );
  /** One round-2 call: the same system prompt, no cacheKey (spec §6.3: retry once). */
  const retry = <T>(
    state: PageState,
    messages: LlmMessage[],
    schema: GenerateRequest<T>["schema"],
    max: number,
  ) =>
    settle(
      options.provider.generate({
        purpose: "write",
        featureId: state.pack.featureId,
        system,
        messages,
        schema,
        maxTokens: max,
        batch,
      }),
    );
  // Each async callback makes its call before its first await, so every call is in this tick.
  const second = await Promise.all(
    retrying.map(
      async (state): Promise<RetryAnswer> =>
        state.rejected !== null
          ? {
              kind: "page",
              outcome: await retry(state, retryRequest(state), PageDraft, MAX_PAGE_OUTPUT_TOKENS),
            }
          : {
              kind: "fixes",
              outcome: await retry(state, fixRequest(state), ClaimFixes, MAX_FIX_OUTPUT_TOKENS),
            },
    ),
  );
  second.forEach((answer, i) => {
    const state = retrying[i] as PageState;
    recordCall(state, answer.outcome);
    if (!("result" in answer.outcome)) {
      state.failure = `the write call failed twice: ${callFailure(answer.outcome.error)}`;
      state.callFailed = !(answer.outcome.error instanceof LlmOutputError);
      return;
    }
    try {
      if (answer.kind === "page") {
        const draft = uniqueDraft(answer.outcome.result.output);
        state.draft = draft;
        verifyAll(state, uniqueClaims(draft), ctx);
        return;
      }
      // Only a claim still failing is fixed: an id already verified, or unknown, is ignored. A
      // body claim given up has no cite list and a lead claim no supports; both stay failing,
      // and are dropped.
      const fixes = new Map(answer.outcome.result.output.claims.map((c) => [c.id, c]));
      const again = [...state.failing.values()].flatMap(({ key, claim }) => {
        const fix = fixes.get(claim.id);
        const gaveUp = key === "lead" ? fix?.supports.length === 0 : fix?.cite.length === 0;
        return fix === undefined || gaveUp ? [] : [{ key, claim: { ...fix, id: claim.id } }];
      });
      verifyAll(state, again, ctx);
    } catch (error) {
      // One page's unexpected error fails that page only; its message may hold model text.
      state.failure = `verifying the claims failed: ${errorClass(error)}`;
    }
  });

  // Wikipedia titles of every surviving claim of a page still being written, and of the History
  // claims it carries (which keep a link only through the same check), checked once for the
  // whole run: a failed page's links are never shown, so they cost no lookup.
  const titles = states.flatMap((s) =>
    s.failure !== null
      ? []
      : [
          ...[...s.verified.values()].map(({ claim }) => claim),
          ...(input.carry?.get(s.pack.featureId) ?? []),
        ].flatMap((claim) => wikipediaTitlesIn(claim.text)),
  );
  const wikipedia = await checkTitles(titles, options.wikipedia, log);

  // The build commit's own date, unless git gave one the infobox cannot store.
  const buildDate = history.find((c) => c.sha === index.sha)?.date;
  const commitDate = IsoDateTime.safeParse(buildDate).success ? buildDate : undefined;
  const pages = states.map((state): PageOutcome => {
    const featureId = state.pack.featureId;
    const failed = [...state.unfixable.values(), ...state.failing.values()];
    const dropped = failed.map(({ key, claim, problems }) => ({
      section: key,
      text: claim.text,
      problems,
    }));
    for (const d of dropped)
      log(`${featureId}: dropped a ${d.section} claim: ${d.problems.join("; ")}`);
    const base = {
      featureId,
      dropped,
      calls: state.calls,
      tokens: state.tokens,
      callFailed: state.callFailed,
    };
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
          claims: withCarried([...state.verified.values()], input.carry?.get(featureId) ?? []),
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
