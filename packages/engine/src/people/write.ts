import {
  type Claim,
  featureLinkTargets,
  IsoDateTime,
  type Manifest,
  PersonRevision,
  PersonSectionKey,
  type TokenUsage,
} from "@repowiki/core";
import { type LlmMessage, LlmOutputError, type Provider } from "@repowiki/llm";
import type { z } from "zod";
import {
  callFailure,
  createClaimLinker,
  errorClass,
  fixRequest,
  orderedSections,
  recordCall,
  rejectionOf,
  retryRequest,
  settle,
  uniqueDraft,
  verifyClaims,
} from "../write/index.ts";
import { ancestorsOf, MAX_CHRONICLE_CLAIMS, type PersonPack, packFor } from "./pack.ts";
import {
  MAX_PERSON_OUTPUT_TOKENS,
  PEOPLE_GIVE_UP,
  PersonDraft,
  type PersonDraftClaim,
  PersonFixes,
  peopleCacheKey,
  peopleSystemPrompt,
  personTurn,
} from "./prompt.ts";
import type { Refreshed } from "./refresh.ts";
import { type PersonVerifyContext, personVerifyContext, verifyPersonClaim } from "./verify.ts";

/** One narrative to write this round. */
export interface PersonRequest {
  personId: string;
  pack: PersonPack;
  ctx: PersonVerifyContext;
  /** The person's current revision, or null for the first. */
  parent: PersonRevision | null;
  /** True for an append (R25): the parent's chronicle is kept and only new episodes are asked. */
  append: boolean;
}

export interface WritePeopleInput {
  requests: readonly PersonRequest[];
  manifest: Manifest;
  /** The snapshot's sha and its commit date. */
  sha: string;
  commitDate: string;
}

export interface WritePeopleOptions {
  provider: Provider;
  repoName: string;
  /** Use the Message Batches API (half price). Default true. */
  batch?: boolean;
  now?: () => Date;
  /** Receives one line per dropped claim and per unwritten narrative; never a name or a claim. */
  log?: (line: string) => void;
}

export interface PersonOutcome {
  personId: string;
  /** Null when the narrative could not be written: the page keeps its computed lead. */
  revision: PersonRevision | null;
  failure: string | null;
  /** True when `failure` is a failed call or batch, not an answer the model gave. */
  callFailed: boolean;
  dropped: { section: PersonSectionKey; problems: string[] }[];
  calls: number;
  tokens: TokenUsage;
}

const MAX_FIX_OUTPUT_TOKENS = 3000;
const ORDER = PersonSectionKey.options;
const NO_NARRATIVE = "no lead or no body claim survived verification";

type Keyed = { key: PersonSectionKey; claim: PersonDraftClaim };

interface State {
  request: PersonRequest;
  /** The user turn: what fixRequest and retryRequest resend. */
  pack: { text: string };
  draft: PersonDraft | null;
  rejected: { text: string; reason: string } | null;
  failure: string | null;
  callFailed: boolean;
  /** The parent's chronicle claims, kept word for word in an append. */
  kept: Claim[];
  verified: Map<string, { key: PersonSectionKey; claim: Claim }>;
  failing: Map<string, { key: PersonSectionKey; claim: PersonDraftClaim; problems: string[] }>;
  tokens: TokenUsage;
  model: string | null;
  calls: number;
}

/**
 * The draft's claims with ids unique on the page and apart from the kept chronicle's ids, which
 * stay as stored so a new lead may support them.
 */
function claimsOf(
  draft: PersonDraft,
  kept: readonly Claim[],
): { draft: PersonDraft; claims: Keyed[] } {
  const held = {
    key: "chronicle" as const,
    claims: kept.map((c) => ({ id: c.id, text: "", cite: [], supports: [] })),
  };
  const [, ...sections] = uniqueDraft({ sections: [held, ...draft.sections] }).sections;
  const unique = { sections };
  return {
    draft: unique,
    claims: sections.flatMap((s) => s.claims.map((claim) => ({ key: s.key, claim }))),
  };
}

/**
 * Writes the round's person narratives (spec v2 #6 §8.4): one call per person, all issued in one
 * tick so they share a Message Batch, then one retry round, also one batch, for narratives whose
 * answer was unusable or had failing claims. A claim that fails twice is dropped and logged. A
 * person left without a lead or a body claim is not written and keeps their computed lead.
 * Lead and chronicle claims are linked through one page linker; each areas claim alone, so it
 * keeps its one feature link; person pages link no Wikipedia article (planner ruling R6). An
 * append keeps the parent's chronicle word for word. People calls carry no feature id (planner
 * ruling R12). Never throws for the model's answer; nothing here touches the store.
 */
export async function writePeople(
  input: WritePeopleInput,
  options: WritePeopleOptions,
): Promise<PersonOutcome[]> {
  const { manifest } = input;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const batch = options.batch ?? true;
  const system = peopleSystemPrompt(options.repoName, manifest);
  const cacheKey = peopleCacheKey(input.sha, system, input.requests.length);
  const call = <T>(
    schema: z.ZodType<T>,
    messages: readonly LlmMessage[],
    maxTokens: number,
    keyed: boolean,
  ) =>
    settle(
      options.provider.generate({
        purpose: "people",
        featureId: null,
        system,
        messages,
        schema,
        maxTokens,
        batch,
        ...(keyed && cacheKey !== null ? { cacheKey } : {}),
      }),
    );
  const states: State[] = input.requests.map((request) => {
    const kept = request.append
      ? (request.parent?.sections.find((s) => s.key === "chronicle")?.claims ?? [])
      : [];
    return {
      request,
      pack: { text: personTurn(request.pack, request.append ? request.parent : null) },
      draft: null,
      rejected: null,
      failure: null,
      callFailed: false,
      kept,
      verified: new Map(kept.map((claim) => [claim.id, { key: "chronicle" as const, claim }])),
      failing: new Map(),
      tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
      model: null,
      calls: 0,
    };
  });
  const verify = (state: State, claims: readonly Keyed[]) =>
    verifyClaims(state, claims, (key, claim) => verifyPersonClaim(key, claim, state.request.ctx));

  // Round 1: one call per person, all issued by this one synchronous map.
  const first = await Promise.all(
    states.map((state) =>
      call(
        PersonDraft,
        [{ role: "user", content: state.pack.text }],
        MAX_PERSON_OUTPUT_TOKENS,
        true,
      ),
    ),
  );
  first.forEach((outcome, i) => {
    const state = states[i] as State;
    recordCall(state, outcome);
    if ("result" in outcome) {
      const { draft, claims } = claimsOf(outcome.result.output, state.kept);
      const body = claims.some((c) => c.key !== "lead") || state.kept.length > 0;
      if (!claims.some((c) => c.key === "lead") || !body) {
        const reason = "the answer needs at least one lead claim and one body claim";
        state.rejected = { text: JSON.stringify(outcome.result.output), reason };
        return;
      }
      state.draft = draft;
      try {
        verify(state, claims);
      } catch (error) {
        state.failure = `verifying the claims failed: ${errorClass(error)}`;
      }
    } else if (outcome.error instanceof LlmOutputError) {
      state.rejected = rejectionOf(outcome.error);
    } else {
      state.failure = `the people call failed: ${callFailure(outcome.error)}`;
      state.callFailed = true;
    }
  });

  // Round 2: one retry per narrative that needs one, all in this tick. No cacheKey: another turn.
  const retrying = states.filter(
    (s) => s.failure === null && (s.rejected !== null || s.failing.size > 0),
  );
  const second = await Promise.all(
    retrying.map(async (state) =>
      state.rejected !== null
        ? {
            kind: "whole" as const,
            outcome: await call(PersonDraft, retryRequest(state), MAX_PERSON_OUTPUT_TOKENS, false),
          }
        : {
            kind: "fixes" as const,
            outcome: await call(
              PersonFixes,
              fixRequest(state, PEOPLE_GIVE_UP),
              MAX_FIX_OUTPUT_TOKENS,
              false,
            ),
          },
    ),
  );
  second.forEach((answer, i) => {
    const state = retrying[i] as State;
    recordCall(state, answer.outcome);
    if (!("result" in answer.outcome)) {
      state.failure = `the people call failed twice: ${callFailure(answer.outcome.error)}`;
      state.callFailed = !(answer.outcome.error instanceof LlmOutputError);
      return;
    }
    try {
      if (answer.kind === "whole") {
        const { draft, claims } = claimsOf(answer.outcome.result.output as PersonDraft, state.kept);
        state.draft = draft;
        verify(state, claims);
        return;
      }
      const fixes = new Map(
        (answer.outcome.result.output as PersonFixes).claims.map((c) => [c.id, c]),
      );
      const again = [...state.failing.values()].flatMap(({ key, claim }) => {
        const fix = fixes.get(claim.id);
        const gaveUp = key === "lead" ? fix?.supports.length === 0 : fix?.cite.length === 0;
        return fix === undefined || gaveUp ? [] : [{ key, claim: { ...fix, id: claim.id } }];
      });
      verify(state, again);
    } catch (error) {
      state.failure = `verifying the claims failed: ${errorClass(error)}`;
    }
  });

  return states.map((state) => {
    const { personId } = state.request;
    const dropped = [...state.failing.values()].map(({ key, problems }) => ({
      section: key,
      problems,
    }));
    for (const d of dropped)
      log(`${personId}: dropped a ${d.section} claim: ${d.problems.join("; ")}`);
    const done = (revision: PersonRevision | null, failure: string | null): PersonOutcome => {
      if (failure !== null) log(`${personId}: narrative not written: ${failure}`);
      return {
        personId,
        revision,
        failure,
        callFailed: state.callFailed,
        dropped,
        calls: state.calls,
        tokens: state.tokens,
      };
    };
    if (state.failure !== null || state.draft === null)
      return done(null, state.failure ?? "the people call returned no usable narrative");
    try {
      return done(...assemble(state, input, now));
    } catch (error) {
      return done(null, `assembling the narrative failed: ${errorClass(error)}`);
    }
  });
}

/** The verified claims as a revision: linked, ordered and renumbered, then schema-checked. */
function assemble(
  state: State,
  input: WritePeopleInput,
  now: () => Date,
): [PersonRevision | null, string | null] {
  const { manifest } = input;
  const kept = new Set(state.kept);
  // Claims keep the draft's order, whichever round verified them: a chronicle is oldest first.
  const place = new Map(
    (state.draft?.sections ?? [])
      .flatMap((sec) => sec.claims.map((cl) => cl.id))
      .map((id, i) => [id, i]),
  );
  const fresh = (key: PersonSectionKey) =>
    [...state.verified.values()]
      .filter((v) => v.key === key && !kept.has(v.claim))
      .sort((a, b) => (place.get(a.claim.id) ?? 0) - (place.get(b.claim.id) ?? 0));
  const page = createClaimLinker(manifest, "", new Map());
  const lead = fresh("lead").map((v) => page(v.claim));
  const chronicle = [...state.kept, ...fresh("chronicle").map((v) => page(v.claim))];
  // Each areas claim is linked alone; one the linker changed past its single link keeps its text.
  const areas = fresh("areas").map(({ claim }) => {
    const linked = createClaimLinker(manifest, "", new Map())(claim);
    return featureLinkTargets(linked.text).length === 1 ? linked : claim;
  });
  const bySection = new Map<PersonSectionKey, Claim[]>([
    ["lead", lead.filter((c) => c.text.trim() !== "")],
    ["chronicle", chronicle.filter((c) => c.text.trim() !== "")],
    ["areas", areas],
  ]);
  const sections = orderedSections(ORDER, bySection);
  if (sections === null) return [null, NO_NARRATIVE];
  const { parent, pack } = state.request;
  const number = parent === null ? 1 : Number(parent.id.slice(parent.id.lastIndexOf("-") + 1)) + 1;
  const commitDate = IsoDateTime.safeParse(input.commitDate).success
    ? input.commitDate
    : now().toISOString();
  const parsed = PersonRevision.safeParse({
    id: `person-${pack.personId}-${input.sha.slice(0, 12)}-${number}`,
    personId: pack.personId,
    sha: input.sha,
    commitDate,
    generatedAt: now().toISOString(),
    parentId: parent?.id ?? null,
    reason: state.request.append ? "update" : "build",
    model: state.model ?? "unknown",
    tokens: state.tokens,
    basis: pack.basis,
    sections,
  });
  if (!parsed.success)
    return [
      null,
      `the narrative does not match the schema at ${parsed.error.issues[0]?.path.join(".")}`,
    ];
  return [parsed.data, null];
}

/**
 * The request for `personId`'s narrative from a refresh (null when the snapshot has no such
 * human): their pack, whole or, for an append, only what is newer than the parent's basis (R25),
 * and its verify context.
 */
export function personRequest(
  refreshed: Refreshed,
  personId: string,
  manifest: Manifest,
  options: { parent: PersonRevision | null; append: boolean; budgetTokens?: number },
): PersonRequest | null {
  // An append adds at most the room its stored chronicle leaves under the cap; with none left,
  // the narrative is written whole, its episodes grouped to fit (the Task 18 ruling).
  const stored = options.parent?.sections.find((s) => s.key === "chronicle")?.claims.length ?? 0;
  const room = MAX_CHRONICLE_CLAIMS - stored;
  const append = options.append && options.parent !== null && room >= 1;
  const covered =
    append && options.parent !== null ? ancestorsOf(refreshed.commits, options.parent.basis) : null;
  const pack = packFor(refreshed, personId, manifest, {
    covered,
    maxEpisodes: append ? room : MAX_CHRONICLE_CLAIMS,
    ...(options.budgetTokens === undefined ? {} : { budgetTokens: options.budgetTokens }),
  });
  if (pack === null) return null;
  const group = refreshed.assigned.ids.indexOf(personId);
  return {
    personId,
    pack,
    ctx: personVerifyContext(refreshed, group, pack, manifest),
    parent: options.parent,
    append,
  };
}
