import {
  Architecture,
  type ArchitectureClaim,
  ArchitectureSectionKey,
  type Manifest,
  type Revision,
  type TokenUsage,
} from "@repowiki/core";
import { type LlmMessage, LlmOutputError, type Provider } from "@repowiki/llm";
import type { z } from "zod";
import type { CommitInfo, RepoIndex } from "../index/index.ts";
import { type WikipediaOptions, wikipediaTitlesIn } from "../link/index.ts";
import {
  type ArchitectureContext,
  ArchitectureDraft,
  type ArchitectureDraftClaim,
  ArchitectureFixes,
  diagramProblems,
  quote,
  verifyArchitectureClaim,
} from "../verify/index.ts";
import { architectureDiagram, crossFeatureEdges } from "./architecture-edges.ts";
import {
  type ArchitecturePack,
  buildArchitecturePack,
  DEFAULT_ARCHITECTURE_BUDGET_TOKENS,
  projectTitle,
} from "./architecture-pack.ts";
import { ARCHITECTURE_GIVE_UP, architectureSystemPrompt } from "./architecture-prompt.ts";
import { addTokens, callFailure, checkTitles, errorClass, type Settled, settle } from "./build.ts";
import { createClaimLinker, orderedSections } from "./page.ts";
import { fixRequest, retryRequest, uniqueDraft } from "./rounds.ts";

export interface ArchitectureInput {
  index: RepoIndex;
  manifest: Manifest;
  /** Text of every readable file at index.sha. */
  sources: ReadonlyMap<string, string>;
  /** Every commit reachable from index.sha, newest first. */
  history: readonly CommitInfo[];
  /** The current page of every active feature the article covers: at least two. */
  pages: readonly Revision[];
  /** The stored article the new one replaces, or null. */
  parent: Architecture | null;
  /** The new revision's 1-based position in the article's history. */
  number: number;
}

export interface ArchitectureOptions {
  provider: Provider;
  repoName: string;
  /** Use the Message Batches API (half price). Default true. */
  batch?: boolean;
  /** The pack's budget. Default DEFAULT_ARCHITECTURE_BUDGET_TOKENS. */
  budgetTokens?: number;
  wikipedia: WikipediaOptions;
  now?: () => Date;
  /** Receives one line per dropped claim, a refused diagram, and an unwritten article. */
  log?: (line: string) => void;
}

/** What happened to the Architecture article this run. */
export interface ArchitectureOutcome {
  /** Null when the article could not be written (see `failure`). */
  architecture: Architecture | null;
  failure: string | null;
  dropped: { section: ArchitectureSectionKey; text: string; problems: string[] }[];
  /** Calls the model answered: 1, or 2 with a retry. */
  calls: number;
  tokens: TokenUsage;
  pack: ArchitecturePack;
}

/** Longest answer the article may take; a feature page's cap. */
export const MAX_ARCHITECTURE_OUTPUT_TOKENS = 8000;
const MAX_FIX_OUTPUT_TOKENS = 4000;
const ORDER = ArchitectureSectionKey.options;
const NO_ARTICLE = "no lead or no body claim survived verification";

interface State {
  pack: ArchitecturePack;
  draft: ArchitectureDraft | null;
  rejected: { text: string; reason: string } | null;
  failure: string | null;
  verified: Map<string, { key: ArchitectureSectionKey; claim: ArchitectureClaim }>;
  failing: Map<
    string,
    { key: ArchitectureSectionKey; claim: ArchitectureDraftClaim; problems: string[] }
  >;
  tokens: TokenUsage;
  model: string | null;
  calls: number;
}

type Keyed = { key: ArchitectureSectionKey; claim: ArchitectureDraftClaim };

const claimsOf = (draft: ArchitectureDraft): Keyed[] =>
  uniqueDraft(draft).sections.flatMap((s) => s.claims.map((claim) => ({ key: s.key, claim })));

/** Verifies claims, lead last, so a lead's supports are checked against the body as it stands. */
function verifyAll(state: State, claims: readonly Keyed[], ctx: ArchitectureContext): void {
  const ordered = [...claims].sort((a, b) => Number(a.key === "lead") - Number(b.key === "lead"));
  for (const { key, claim } of ordered) {
    const checked = verifyArchitectureClaim(key, claim, ctx);
    const problems = [...checked.problems];
    if (key === "lead") {
      const unknown = claim.supports.filter((id) => {
        const target = state.verified.get(id) ?? state.failing.get(id);
        return target === undefined || target.key === "lead";
      });
      if (unknown.length > 0) {
        problems.push(
          `the lead supports ${unknown
            .slice(0, 3)
            .map((id) => quote(id))
            .join(", ")}, which are not body claims`,
        );
      }
    }
    if (checked.claim !== null && problems.length === 0) {
      state.failing.delete(claim.id);
      state.verified.set(claim.id, { key, claim: checked.claim });
    } else {
      state.failing.set(claim.id, { key, claim, problems });
    }
  }
}

/**
 * Writes the Architecture article (spec §7.4), the project's own article titled with
 * projectTitle, from the build's verified pages and the README: one call, its own
 * round (batched by default, no cacheKey), with the same one-retry rule as a page (§6.3): an
 * unusable answer is asked for again whole, failing claims go back once with their problems, and
 * a claim that fails twice is dropped. Surviving claims are linked like a page's, the diagram is
 * the engine's own, and the article is checked against core's schema. Never throws for the
 * model's answer; a failed call or an empty article is a `failure`. Nothing here touches the store.
 */
export async function writeArchitecture(
  input: ArchitectureInput,
  options: ArchitectureOptions,
): Promise<ArchitectureOutcome> {
  const { index, manifest, sources, history } = input;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const batch = options.batch ?? true;
  const pageIds = new Set(input.pages.map((p) => p.featureId));
  const edges = crossFeatureEdges(index, manifest, pageIds);
  const title = projectTitle(options.repoName, sources);
  const pack = buildArchitecturePack({
    title,
    manifest,
    index,
    sources,
    pages: input.pages,
    edges,
    budgetTokens: options.budgetTokens ?? DEFAULT_ARCHITECTURE_BUDGET_TOKENS,
  });
  const symbols = new Map(index.files.map((f) => [f.path, f.symbols]));
  const ctx: ArchitectureContext = {
    sha: index.sha,
    sources,
    symbolsOf: (path) => symbols.get(path) ?? [],
    commits: history,
    pages: pageIds,
  };
  const system = architectureSystemPrompt(options.repoName, manifest);
  const state: State = {
    pack,
    draft: null,
    rejected: null,
    failure: null,
    verified: new Map(),
    failing: new Map(),
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    model: null,
    calls: 0,
  };
  const record = (outcome: Settled<unknown>) => {
    if ("result" in outcome) {
      state.calls += 1;
      state.tokens = addTokens(state.tokens, outcome.result.usage);
      state.model ??= outcome.result.model;
    } else if (outcome.error instanceof LlmOutputError) {
      state.calls += 1;
      if (outcome.error.usage !== undefined) {
        state.tokens = addTokens(state.tokens, outcome.error.usage);
      }
      state.model ??= outcome.error.model ?? null;
    }
  };
  const call = <T>(schema: z.ZodType<T>, messages: readonly LlmMessage[], maxTokens: number) =>
    settle(
      options.provider.generate({ purpose: "write", system, messages, schema, maxTokens, batch }),
    );
  const outcome = (
    architecture: Architecture | null,
    failure: string | null,
  ): ArchitectureOutcome => {
    const dropped = [...state.failing.values()].map(({ key, claim, problems }) => ({
      section: key,
      text: claim.text,
      problems,
    }));
    for (const d of dropped)
      log(`architecture: dropped a ${d.section} claim: ${d.problems.join("; ")}`);
    if (failure !== null) log(`architecture: not written: ${failure}`);
    return { architecture, failure, dropped, calls: state.calls, tokens: state.tokens, pack };
  };

  const first = await call(
    ArchitectureDraft,
    [{ role: "user", content: pack.text }],
    MAX_ARCHITECTURE_OUTPUT_TOKENS,
  );
  record(first);
  if ("result" in first) {
    const draft = uniqueDraft(first.result.output);
    const claims = claimsOf(draft);
    if (!claims.some((c) => c.key === "lead") || claims.every((c) => c.key === "lead")) {
      const reason = "the answer needs at least one lead claim and one body claim";
      state.rejected = { text: JSON.stringify(first.result.output), reason };
    } else {
      state.draft = draft;
      try {
        verifyAll(state, claims, ctx);
      } catch (error) {
        return outcome(null, `verifying the claims failed: ${errorClass(error)}`);
      }
    }
  } else if (first.error instanceof LlmOutputError) {
    state.rejected = { text: first.error.text, reason: first.error.message };
  } else {
    return outcome(null, `the architecture call failed: ${callFailure(first.error)}`);
  }

  if (state.rejected !== null || state.failing.size > 0) {
    const rejected = state.rejected !== null;
    const second = rejected
      ? await call(ArchitectureDraft, retryRequest(state), MAX_ARCHITECTURE_OUTPUT_TOKENS)
      : await call(
          ArchitectureFixes,
          fixRequest(state, ARCHITECTURE_GIVE_UP),
          MAX_FIX_OUTPUT_TOKENS,
        );
    record(second);
    if (!("result" in second)) {
      return outcome(null, `the architecture call failed twice: ${callFailure(second.error)}`);
    }
    try {
      if (rejected) {
        const draft = uniqueDraft(second.result.output as ArchitectureDraft);
        state.draft = draft;
        verifyAll(state, claimsOf(draft), ctx);
      } else {
        const fixes = new Map(
          (second.result.output as ArchitectureFixes).claims.map((c) => [c.id, c]),
        );
        const again = [...state.failing.values()].flatMap(({ key, claim }) => {
          const fix = fixes.get(claim.id);
          const gaveUp =
            key === "lead"
              ? fix?.supports.length === 0
              : fix?.cite.length === 0 && fix.pages.length === 0;
          return fix === undefined || gaveUp ? [] : [{ key, claim: { ...fix, id: claim.id } }];
        });
        verifyAll(state, again, ctx);
      }
    } catch (error) {
      return outcome(null, `verifying the claims failed: ${errorClass(error)}`);
    }
  }
  if (state.draft === null)
    return outcome(null, "the architecture call returned no usable article");

  const titles = [...state.verified.values()].flatMap(({ claim }) => wikipediaTitlesIn(claim.text));
  const wikipedia = await checkTitles(titles, options.wikipedia, log);
  try {
    const linkClaim = createClaimLinker(manifest, "", wikipedia.links);
    const bySection = new Map(
      ORDER.map((key) => [
        key,
        [...state.verified.values()].filter((v) => v.key === key).map((v) => v.claim),
      ]),
    );
    const ordered = orderedSections(ORDER, bySection);
    if (ordered === null) return outcome(null, NO_ARTICLE);
    const linked = ordered.map((s) => ({
      key: s.key,
      claims: s.claims.map(linkClaim).filter((c) => c.text.trim() !== ""),
    }));
    const sections = orderedSections(ORDER, new Map(linked.map((s) => [s.key, s.claims])));
    if (sections === null) return outcome(null, NO_ARTICLE);

    const titleOf = new Map(manifest.features.map((f) => [f.id, f.title]));
    const features = [...pageIds].sort().map((id) => ({ id, title: titleOf.get(id) ?? id }));
    let diagram = architectureDiagram(edges, features);
    const refused = diagram === null ? [] : diagramProblems(diagram);
    for (const problem of refused) log(`architecture: diagram refused: ${problem}`);
    if (refused.length > 0) diagram = null;
    const parsed = Architecture.safeParse({
      id: `architecture-${index.sha.slice(0, 12)}-${input.number}`,
      sha: index.sha,
      title,
      commitDate: history.find((c) => c.sha === index.sha)?.date ?? now().toISOString(),
      generatedAt: now().toISOString(),
      parentId: input.parent?.id ?? null,
      reason: "build",
      pr: null,
      model: state.model ?? "unknown",
      tokens: state.tokens,
      basis: input.pages.map((p) => p.id).sort(),
      edges: edges.map(({ from, to, imports, calls }) => ({ from, to, imports, calls })),
      diagram,
      sections,
    });
    if (!parsed.success) {
      return outcome(
        null,
        `the article does not match the schema at ${parsed.error.issues[0]?.path.join(".")}`,
      );
    }
    return outcome(parsed.data, null);
  } catch (error) {
    return outcome(null, `assembling the article failed: ${errorClass(error)}`);
  }
}
