import {
  Architecture,
  type ArchitectureClaim,
  ArchitectureSectionKey,
  IsoDateTime,
  type Manifest,
  type Revision,
  type TokenUsage,
} from "@repowiki/core";
import { type LlmMessage, LlmOutputError, type Provider } from "@repowiki/llm";
import type { z } from "zod";
import type { CommitInfo, RepoIndex } from "../index/index.ts";
import { textLinkViolations, type WikipediaOptions, wikipediaTitlesIn } from "../link/index.ts";
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
import { callFailure, checkTitles, errorClass, recordCall, settle } from "./build.ts";
import { createClaimLinker, orderedSections } from "./page.ts";
import { fixRequest, rejectionOf, retryRequest, uniqueDraft, verifyClaims } from "./rounds.ts";

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
  /** "update" when an update rewrites the article (default "build"). */
  reason?: "build" | "update";
  /** The PR the update's commit merged (default null). */
  pr?: number | null;
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
  /** Calls the model answered: 0 when the first call failed, 1, or 2 with a retry. */
  calls: number;
  tokens: TokenUsage;
  pack: ArchitecturePack;
}

/**
 * Longest answer the article may take: twice a feature page's cap, since the article covers every
 * feature (the prompt also caps each section's claims).
 */
export const MAX_ARCHITECTURE_OUTPUT_TOKENS = 16000;
const MAX_FIX_OUTPUT_TOKENS = 4000;
const ORDER = ArchitectureSectionKey.options;
const NO_ARTICLE = "no lead or no body claim survived verification";

interface State {
  pack: ArchitecturePack;
  draft: ArchitectureDraft | null;
  rejected: { text: string; reason: string } | null;
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
    shown: pack.shown,
  };
  const system = architectureSystemPrompt(options.repoName, manifest);
  const state: State = {
    pack,
    draft: null,
    rejected: null,
    verified: new Map(),
    failing: new Map(),
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    model: null,
    calls: 0,
  };
  const verify = (claims: readonly Keyed[]) =>
    verifyClaims(state, claims, (key, claim) => verifyArchitectureClaim(key, claim, ctx));
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
  recordCall(state, first);
  if ("result" in first) {
    const draft = uniqueDraft(first.result.output);
    const claims = claimsOf(draft);
    if (!claims.some((c) => c.key === "lead") || claims.every((c) => c.key === "lead")) {
      const reason = "the answer needs at least one lead claim and one body claim";
      state.rejected = { text: JSON.stringify(first.result.output), reason };
    } else {
      state.draft = draft;
      try {
        verify(claims);
      } catch (error) {
        return outcome(null, `verifying the claims failed: ${errorClass(error)}`);
      }
    }
  } else if (first.error instanceof LlmOutputError) {
    state.rejected = rejectionOf(first.error);
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
    recordCall(state, second);
    if (!("result" in second)) {
      return outcome(null, `the architecture call failed twice: ${callFailure(second.error)}`);
    }
    try {
      if (rejected) {
        const draft = uniqueDraft(second.result.output as ArchitectureDraft);
        state.draft = draft;
        verify(claimsOf(draft));
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
        verify(again);
      }
    } catch (error) {
      return outcome(null, `verifying the claims failed: ${errorClass(error)}`);
    }
  }

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
    // The build commit's own date, unless git gave one the article cannot store.
    const buildDate = history.find((c) => c.sha === index.sha)?.date;
    const commitDate = IsoDateTime.safeParse(buildDate).success ? buildDate : undefined;
    const parsed = Architecture.safeParse({
      id: `architecture-${index.sha.slice(0, 12)}-${input.number}`,
      sha: index.sha,
      title,
      commitDate: commitDate ?? now().toISOString(),
      generatedAt: now().toISOString(),
      parentId: input.parent?.id ?? null,
      reason: input.reason ?? "build",
      pr: input.pr ?? null,
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
    // The checks above make this unreachable; it stays as the last word on spec §8.
    const violations = parsed.data.sections.flatMap((section) =>
      section.claims.flatMap((claim) =>
        textLinkViolations(claim.text, manifest).map((problem) => `${quote(claim.id)}: ${problem}`),
      ),
    );
    if (violations.length > 0) return outcome(null, `links to nowhere: ${violations.join("; ")}`);
    return outcome(parsed.data, null);
  } catch (error) {
    return outcome(null, `assembling the article failed: ${errorClass(error)}`);
  }
}
