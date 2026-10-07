import {
  CLAIM_TEXT_MAX_LENGTH,
  type CodeCitation,
  INFLIGHT_MAX_CLAIM_CITATIONS,
  INFLIGHT_MAX_CLAIM_FEATURES,
  INFLIGHT_MAX_SUMMARY_CLAIMS,
  type InFlightClaim,
  InFlightSummary,
  type Manifest,
  type TokenUsage,
  ungroundedCodeToken,
} from "@repowiki/core";
import { LlmOutputError, type Provider } from "@repowiki/llm";
import { z } from "zod";
import { createPageLinker } from "../link/index.ts";
import { estimateTokens } from "../manifest/index.ts";
import {
  citedLines,
  claimTextProblems,
  resolveCitations,
  type VerifyContext,
} from "../verify/index.ts";
import {
  INFLIGHT_MAX_OUTPUT_TOKENS,
  inflightSystemPrompt,
  type PackInput,
  summaryPack,
  summaryRequestKey,
} from "./summary-pack.ts";

/** The summary call's structured answer (spec v2 #9 §7.1); its limits are checked in verify. */
export const InFlightAnswer = z.object({
  claims: z.array(
    z.object({ text: z.string(), cite: z.array(z.string()), features: z.array(z.string()) }),
  ),
});
export type InFlightAnswer = z.infer<typeof InFlightAnswer>;

/** One pull request's summary call, and what its answer is checked against. */
export interface SummaryRequest {
  number: number;
  headSha: string;
  /** The cache key (summaryRequestKey). */
  key: string;
  system: string;
  user: string;
  /** Estimated input tokens: the system prompt and the user turn. */
  tokens: number;
  /** The head lines the pack shows, by path: the only lines a claim may cite. */
  shown: ReadonlyMap<string, ReadonlySet<number>>;
  /** The shown lines each file's change touches (SummaryPack.changed). */
  changed: ReadonlyMap<string, ReadonlySet<number>>;
  /** Each file's removed lines as shown, by the head line they show before. */
  removed: ReadonlyMap<string, ReadonlyMap<number, readonly string[]>>;
  /** Text at the head of every file the pull request changes and keeps. */
  sources: ReadonlyMap<string, string>;
  /** The features it touches. */
  touched: readonly string[];
}

/** The summary request of one fetched pull request, for `model` (the inflight role's). */
export function summaryRequest(input: PackInput, model: string): SummaryRequest {
  const system = inflightSystemPrompt();
  const pack = summaryPack(input);
  const kept = new Set(input.changes.flatMap((c) => (c.newPath === null ? [] : [c.newPath])));
  return {
    number: input.pull.number,
    headSha: input.pull.headRefOid,
    key: summaryRequestKey(model, system, pack.text),
    system,
    user: pack.text,
    tokens: estimateTokens(system) + pack.tokens,
    shown: pack.shown,
    changed: pack.changed,
    removed: pack.removed,
    sources: new Map([...input.head].filter(([path]) => kept.has(path))),
    touched: input.features.map((f) => f.featureId),
  };
}

/** What one answer kept: the summary (null when no claim verified) and how many it dropped. */
export interface Verified {
  summary: InFlightSummary | null;
  dropped: number;
}

/** The feature ids a linked claim text links to (`[[id]]` or `[[id|words]]`), Wikipedia aside. */
function linkedFeatures(linked: string): string[] {
  return [...linked.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].flatMap((m) =>
    m[1] === undefined || m[1].startsWith("wp:") ? [] : [m[1]],
  );
}

/**
 * What a claim citing `citations` may name (spec v2 #4 R6, as the Ask sidebar's sentences): each
 * cited path, its cited head lines, and the removed lines the pack shows beside them (before any
 * cited line, or just after the last).
 */
function groundOf(request: SummaryRequest, citations: readonly CodeCitation[]): string {
  return citations
    .flatMap((c) => {
      const removed = request.removed.get(c.path);
      const beside: string[] = [];
      for (let n = c.startLine; n <= c.endLine + 1; n++) beside.push(...(removed?.get(n) ?? []));
      return [
        c.path,
        citedLines(request.sources.get(c.path) ?? "", c.startLine, c.endLine),
        ...beside,
      ];
    })
    .join("\n");
}

/**
 * An answer's claims that hold (R10), in order, at most five: each is one paragraph of the claim
 * subset (claimTextProblems), cites 1-3 ranges of head lines the pack showed of files the pull
 * request changes (resolveCitations, ≤ MAX_CITED_LINES, hashed at the head), at least one of
 * them a changed line (spec v2 #9 §7.1), names no code-like token its cited lines do not write
 * and links no feature the pull request does not touch, names only touched features (others are
 * dropped, at most three kept), and is linked over the wiki's manifest once it is kept, so a
 * dropped claim takes no first-mention link. A claim with any problem is dropped; there is no
 * retry round. Ids are the engine's: p<n>-c<k>.
 */
export function verifySummary(
  request: SummaryRequest,
  answer: InFlightAnswer,
  manifest: Manifest,
  call: { model: string; usage: TokenUsage },
  generatedAt: string,
): Verified {
  const ctx: VerifyContext = {
    sha: request.headSha,
    sources: request.sources,
    symbolsOf: () => [],
    commits: [],
  };
  const link = createPageLinker(manifest, "", new Map());
  const touched = new Set(request.touched);
  const claims: InFlightClaim[] = [];
  let dropped = 0;
  for (const draft of answer.claims) {
    if (claims.length >= INFLIGHT_MAX_SUMMARY_CLAIMS) {
      dropped++;
      continue;
    }
    const text = draft.text.trim();
    const resolved = resolveCitations(draft.cite, ctx);
    const citations = resolved.citations.flatMap((c) => (c.kind === "code" ? [c] : []));
    const lines = (c: CodeCitation) =>
      Array.from({ length: c.endLine - c.startLine + 1 }, (_, i) => c.startLine + i);
    const ok =
      claimTextProblems(text, ctx).length === 0 &&
      draft.cite.length >= 1 &&
      draft.cite.length <= INFLIGHT_MAX_CLAIM_CITATIONS &&
      !resolved.unresolved &&
      citations.length === resolved.citations.length &&
      citations.every((c) => lines(c).every((n) => request.shown.get(c.path)?.has(n) === true)) &&
      citations.some((c) => lines(c).some((n) => request.changed.get(c.path)?.has(n) === true)) &&
      ungroundedCodeToken(groundOf(request, citations), text) === null &&
      // A throwaway linker, so a claim dropped here takes no first-mention link.
      linkedFeatures(createPageLinker(manifest, "", new Map())(text)).every((id) =>
        touched.has(id),
      );
    const linked = ok ? link(text) : "";
    if (!ok || linked === "" || linked.length > CLAIM_TEXT_MAX_LENGTH) {
      dropped++;
      continue;
    }
    const features = [...new Set(draft.features.map((f) => f.trim()))]
      .filter((f) => touched.has(f))
      .slice(0, INFLIGHT_MAX_CLAIM_FEATURES);
    claims.push({
      id: `p${request.number}-c${claims.length + 1}`,
      text: linked,
      citations,
      features,
    });
  }
  if (claims.length === 0) return { summary: null, dropped };
  return {
    summary: InFlightSummary.parse({ model: call.model, generatedAt, tokens: call.usage, claims }),
    dropped,
  };
}

/**
 * One request's outcome: its verified summary, or why there is none this run, with what the call
 * spent when it was answered (an answer that verified to nothing, or one that was not usable).
 */
export type SummaryOutcome =
  | { summary: InFlightSummary; dropped: number }
  | { summary: null; failure: string; usage?: TokenUsage; model?: string };

/**
 * Sends every request at once (role `inflight`, no cacheKey, R11), so batched calls share one
 * Message Batch, and verifies each answer (verifySummary). A call that fails, an answer that does
 * not parse, and an answer with no claim left are each that pull request's failure: it gets no
 * summary and no cache entry this run, and the run goes on.
 */
export async function summarize(
  requests: readonly SummaryRequest[],
  manifest: Manifest,
  provider: Provider,
  options: { batch: boolean; now?: () => Date },
): Promise<Map<number, SummaryOutcome>> {
  const now = options.now ?? (() => new Date());
  const settled = await Promise.allSettled(
    requests.map((request) =>
      provider.generate({
        purpose: "inflight",
        featureId: null,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        schema: InFlightAnswer,
        maxTokens: INFLIGHT_MAX_OUTPUT_TOKENS,
        batch: options.batch,
      }),
    ),
  );
  const outcomes = new Map<number, SummaryOutcome>();
  settled.forEach((result, i) => {
    const request = requests[i] as SummaryRequest;
    if (result.status === "rejected") {
      const why = result.reason instanceof Error ? result.reason.message : "the call failed";
      const spent =
        result.reason instanceof LlmOutputError &&
        result.reason.usage !== undefined &&
        result.reason.model !== undefined
          ? { usage: result.reason.usage, model: result.reason.model }
          : {};
      outcomes.set(request.number, { summary: null, failure: why, ...spent });
      return;
    }
    const { output, usage, model } = result.value;
    const verified = verifySummary(
      request,
      output,
      manifest,
      { model, usage },
      now().toISOString(),
    );
    outcomes.set(
      request.number,
      verified.summary === null
        ? {
            summary: null,
            failure: `no claim verified (${verified.dropped} dropped)`,
            usage,
            model,
          }
        : { summary: verified.summary, dropped: verified.dropped },
    );
  });
  return outcomes;
}
