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
} from "@repowiki/core";
import type { Provider } from "@repowiki/llm";
import { z } from "zod";
import { createPageLinker } from "../link/index.ts";
import { estimateTokens } from "../manifest/index.ts";
import { claimTextProblems, resolveReference, type VerifyContext } from "../verify/index.ts";
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
    sources: new Map([...input.head].filter(([path]) => kept.has(path))),
    touched: input.features.map((f) => f.featureId),
  };
}

/** What one answer kept: the summary (null when no claim verified) and how many it dropped. */
export interface Verified {
  summary: InFlightSummary | null;
  dropped: number;
}

/**
 * An answer's claims that hold (R10), in order, at most five: each is one paragraph of the claim
 * subset (claimTextProblems), cites 1-3 ranges of head lines the pack showed of files the pull
 * request changes (resolveReference, ≤ MAX_CITED_LINES, hashed at the head), names only touched
 * features (others are dropped, at most three kept), and is linked over the wiki's manifest. A
 * claim with any problem is dropped; there is no retry round. Ids are the engine's: p<n>-c<k>.
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
    const citations: CodeCitation[] = [];
    let ok = claimTextProblems(text, ctx).length === 0;
    ok &&= draft.cite.length >= 1 && draft.cite.length <= INFLIGHT_MAX_CLAIM_CITATIONS;
    for (const ref of draft.cite) {
      const resolved = resolveReference(ref, ctx);
      if ("problem" in resolved || resolved.citation.kind !== "code") {
        ok = false;
        continue;
      }
      const c = resolved.citation;
      const shown = request.shown.get(c.path);
      for (let n = c.startLine; n <= c.endLine; n++) if (shown?.has(n) !== true) ok = false;
      if (
        !citations.some(
          (x) => x.path === c.path && x.startLine === c.startLine && x.endLine === c.endLine,
        )
      )
        citations.push(c);
    }
    const linked = link(text);
    ok &&= linked !== "" && linked.length <= CLAIM_TEXT_MAX_LENGTH;
    if (!ok) {
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

/** One request's outcome: its verified summary, or why there is none this run. */
export type SummaryOutcome =
  | { summary: InFlightSummary; dropped: number }
  | { summary: null; failure: string };

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
      outcomes.set(request.number, { summary: null, failure: why });
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
        ? { summary: null, failure: `no claim verified (${verified.dropped} dropped)` }
        : { summary: verified.summary, dropped: verified.dropped },
    );
  });
  return outcomes;
}
