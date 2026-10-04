import { createHash } from "node:crypto";
import type { Claim, Manifest, SectionKey, TokenUsage } from "@repowiki/core";
import { type LlmMessage, LlmOutputError, type Provider } from "@repowiki/llm";
import type { CommitInfo, RepoIndex } from "../index/index.ts";
import {
  type DraftDiagram,
  quote,
  type UpdateClaim,
  UpdateDraft,
  UpdateFixes,
  type VerifyContext,
  verifyClaim,
} from "../verify/index.ts";
import {
  type CallTally,
  callFailure,
  errorClass,
  recordCall,
  type Settled,
  settle,
} from "./build.ts";
import { MAX_FIX_CLAIMS, MAX_PROBLEMS_PER_CLAIM, rejectionOf, retryRequest } from "./rounds.ts";
import { buildUpdatePack, type PageRewrite, type UpdatePack } from "./update-pack.ts";
import { updateSystemPrompt } from "./update-prompt.ts";

export interface RewriteInput {
  /** The pages to update. */
  rewrites: readonly PageRewrite[];
  /** At the new commit. */
  index: RepoIndex;
  manifest: Manifest;
  sources: ReadonlyMap<string, string>;
  /** Every commit reachable from the new commit, newest first. */
  history: readonly CommitInfo[];
}

export interface RewriteOptions {
  provider: Provider;
  repoName: string;
  /** Default true: nothing waits on an update. */
  batch?: boolean;
  /** The update pack's budget (default: a page pack's 30,000). */
  budgetTokens?: number;
  log?: (line: string) => void;
}

/** One page's update answers, verified. */
export interface RewriteOutcome {
  featureId: string;
  pack: UpdatePack;
  /** Verified rewrites of stale claims, by id. */
  replaced: Map<string, Claim>;
  /** Stale claims left as they were: failed verification (after the one retry), given up, or never answered (spec §6.3). */
  keptStale: string[];
  /** New claims that verified, in the order written. */
  added: { key: SectionKey; claim: Claim }[];
  /** New claims that failed verification and were not fixed by the one retry, with the problems. */
  dropped: { section: SectionKey; text: string; problems: string[] }[];
  /** The answer's diagram when the pack offered candidates, else null. */
  diagram: DraftDiagram | null;
  calls: number;
  tokens: TokenUsage;
  model: string | null;
  /** Set when a call failed (not an unusable answer): the update stops (spec §6.3). */
  failure: string | null;
  /** True when `failure` is a failed call or batch, never an answer the model gave. */
  callFailed?: boolean;
}

/** The most an update answer may take: corrected claims and a few new ones. */
export const MAX_UPDATE_OUTPUT_TOKENS = 4000;

/** The update calls' cacheKey: the sha plus a hash of the shared prefix (see writeCacheKey). */
export function updateCacheKey(sha: string, system: string): string {
  return `update-${sha}-${createHash("sha256").update(system).digest("hex").slice(0, 12)}`;
}

/** How an update's retry turn says to give a claim up. */
export const UPDATE_GIVE_UP =
  "You may give up a STALE claim you cannot support from the pack: return it with an empty cite list (a lead claim: an empty supports list); it stays on the page, marked out of date.";

interface State extends CallTally {
  rewrite: PageRewrite;
  pack: UpdatePack;
  /** Raw text of an unusable first answer, and why. */
  rejected: { text: string; reason: string } | null;
  /** The first usable answer, for the retry turn. */
  answer: string | null;
  replaced: Map<string, Claim>;
  given: Set<string>;
  added: Map<string, { key: SectionKey; claim: Claim }>;
  failing: Map<
    string,
    { key: SectionKey; claim: UpdateClaim; problems: string[]; target: boolean }
  >;
  diagram: DraftDiagram | null;
  failure: string | null;
  callFailed: boolean;
}

/**
 * The engine owns the ids of new claims (the model cannot see every id a later update will
 * find on the page). A claim whose id is not a stale claim's is new, and it keeps its id only
 * if no claim on the page and no earlier new claim of the answer uses it; otherwise it gets
 * the next unused `n<k>`, deterministically. A repeat of a fresh claim, word for word, is not
 * new: it keeps its id and `check` ignores it. A lead's supports that named the model's id for
 * a new claim that collided with a claim on the page name the renamed claim instead (unless the
 * lead already supported the page's claim of that id). Pure: the answer is returned as given
 * when nothing collides.
 */
export function assignNewIds(rewrite: PageRewrite, claims: readonly UpdateClaim[]): UpdateClaim[] {
  const onPage = new Map(rewrite.claims.map((c) => [c.claim.id, c]));
  const targets = new Set(
    rewrite.claims.filter((c) => c.status === "stale").map((c) => c.claim.id),
  );
  const taken = new Set([...onPage.keys(), ...claims.map((c) => c.id.trim())]);
  const kept = new Set<string>();
  const renamed = new Map<string, string>();
  let next = 0;
  const unused = (): string => {
    do next += 1;
    while (taken.has(`n${next}`));
    taken.add(`n${next}`);
    return `n${next}`;
  };
  const out = claims.map((raw) => {
    const id = raw.id.trim();
    const before = onPage.get(id);
    const repeat =
      before !== undefined &&
      !targets.has(id) &&
      before.key === raw.section &&
      before.claim.text === raw.text;
    if ((before !== undefined && targets.has(id)) || repeat) return { ...raw, id };
    if (before === undefined && !kept.has(id)) {
      kept.add(id);
      return { ...raw, id };
    }
    const fresh = unused();
    if (before !== undefined && !renamed.has(id)) renamed.set(id, fresh);
    return { ...raw, id: fresh };
  });
  if (renamed.size === 0) return out;
  return out.map((claim) => {
    if (claim.section !== "lead") return claim;
    const stored = new Set(onPage.get(claim.id)?.claim.supports ?? []);
    return {
      ...claim,
      supports: claim.supports.map((id) =>
        renamed.has(id) && !stored.has(id) ? (renamed.get(id) as string) : id,
      ),
    };
  });
}

/**
 * Checks one answer's claims against the page: a stale claim's rewrite must stay in its section
 * and verify at the new commit (a lead's supports must name body claims of the page); a new
 * claim must go in a section the pack opened, and a new history claim must cite one of the
 * update's commits. A rewrite with an empty cite list (a lead: empty supports) gives the claim
 * up: it stays stale. A claim the pack did not mark stale is ignored: it stays word for word.
 * `only`, on the retry, limits the check to the claims still failing. A stale claim the answer
 * leaves out of round 1 fails with a problem, so the retry asks for it.
 */
function check(
  state: State,
  claims: readonly UpdateClaim[],
  ctx: VerifyContext,
  only: Set<string> | null,
  log: (line: string) => void,
): void {
  const old = new Map(state.rewrite.claims.map((c) => [c.claim.id, c]));
  const targets = new Set(state.pack.targets);
  const newShas = new Set(state.rewrite.commits.map((c) => c.sha));
  const bodyIds = new Set(
    state.rewrite.claims.filter((c) => c.key !== "lead").map((c) => c.claim.id),
  );
  const seen = new Set<string>();
  const leads: UpdateClaim[] = [];
  const fail = (claim: UpdateClaim, key: SectionKey, problems: string[], target: boolean) =>
    state.failing.set(claim.id, { key, claim, problems, target });
  for (const raw of claims) {
    const claim = { ...raw, id: raw.id.trim() };
    if (only !== null && !only.has(claim.id)) {
      log(
        `${state.rewrite.featureId}: ignored ${quote(claim.id)} in the retry, which did not ask for it`,
      );
      continue;
    }
    if (seen.has(claim.id)) {
      log(`${state.rewrite.featureId}: ignored a repeated claim ${quote(claim.id)}`);
      continue;
    }
    seen.add(claim.id);
    const before = old.get(claim.id);
    if (before !== undefined && !targets.has(claim.id)) {
      log(
        `${state.rewrite.featureId}: ignored a rewrite of ${quote(claim.id)}, which is not stale`,
      );
      continue;
    }
    const target = before !== undefined;
    const key = target ? before.key : claim.section;
    if (target && claim.section !== before.key) {
      fail(claim, key, [`claim ${quote(claim.id)} belongs in ${before.key}; keep it there`], true);
      continue;
    }
    if (!target && !state.pack.open.includes(key)) {
      const open = state.pack.open.length > 0 ? state.pack.open.join(" and ") : "no section";
      fail(claim, key, [`new claims go only in ${open} on this update`], false);
      continue;
    }
    const gaveUp = key === "lead" ? claim.supports.length === 0 : claim.cite.length === 0;
    if (target && gaveUp) {
      state.given.add(claim.id);
      state.failing.delete(claim.id);
      continue;
    }
    if (key === "lead") {
      leads.push(claim);
      continue;
    }
    const verified = verifyClaim(key, claim, ctx);
    const problems = [...verified.problems];
    if (
      verified.claim !== null &&
      key === "history" &&
      !target &&
      !verified.claim.citations.some((c) => c.kind === "commit" && newShas.has(c.sha))
    ) {
      problems.push("a new history claim cites one of the commits since the last revision");
    }
    if (verified.claim === null || problems.length > 0) {
      fail(claim, key, problems, target);
      continue;
    }
    state.failing.delete(claim.id);
    if (target) state.replaced.set(claim.id, { ...verified.claim, hook: before.claim.hook });
    else {
      state.added.set(claim.id, { key, claim: verified.claim });
      bodyIds.add(claim.id);
    }
  }
  for (const id of state.added.keys()) bodyIds.add(id);
  for (const claim of leads) {
    const verified = verifyClaim("lead", claim, ctx);
    const unknown = claim.supports.filter((id) => !bodyIds.has(id));
    const problems = [
      ...verified.problems,
      ...(unknown.length > 0
        ? [
            `the lead supports ${unknown.map(quote).join(", ")}, which are not body claims of the page`,
          ]
        : []),
    ];
    if (verified.claim === null || problems.length > 0) fail(claim, "lead", problems, true);
    else {
      state.failing.delete(claim.id);
      const stored = old.get(claim.id)?.claim.hook ?? verified.claim.hook;
      state.replaced.set(claim.id, { ...verified.claim, hook: stored });
    }
  }
  if (only === null) {
    for (const id of targets) {
      if (!seen.has(id) && !state.replaced.has(id) && !state.given.has(id)) {
        const before = old.get(id);
        const placeholder = {
          id,
          section: before?.key ?? "overview",
          text: before?.claim.text ?? "",
          cite: [],
          supports: [],
          hook: false,
        };
        fail(
          placeholder as UpdateClaim,
          before?.key ?? "overview",
          ["no corrected version was returned; return one, or give the claim up"],
          true,
        );
      }
    }
  }
}

/** The retry turn for failing claims: the pack, the first answer, and their problems. */
function fixRequest(state: State): LlmMessage[] {
  const failing = [...state.failing.values()];
  const listed = failing.slice(0, MAX_FIX_CLAIMS).map(({ claim, problems }) => {
    const shown = problems.slice(0, MAX_PROBLEMS_PER_CLAIM);
    if (problems.length > MAX_PROBLEMS_PER_CLAIM) {
      shown.push(`and ${problems.length - MAX_PROBLEMS_PER_CLAIM} more`);
    }
    return `- ${quote(claim.id)}: ${shown.join("; ")}`;
  });
  if (failing.length > MAX_FIX_CLAIMS) {
    listed.push(`- and ${failing.length - MAX_FIX_CLAIMS} more claims failed`);
  }
  return [
    { role: "user", content: state.pack.text },
    { role: "assistant", content: state.answer ?? "{}" },
    {
      role: "user",
      content: `These claims failed:\n${listed.join("\n")}\nReturn corrected versions of only these claims, under the same ids, citing only lines and commits the pack shows. ${UPDATE_GIVE_UP}`,
    },
  ];
}

/**
 * Updates the dirty pages of an update (spec §6.1 step 5): one call per page, all issued in one
 * tick so they share one Message Batch (or, unbatched, a cached prefix when there are two or
 * more), then
 * one retry round, also one batch, for pages whose answer was unusable or had claims that
 * failed (§6.3: retry once with the verifier's problems). A stale claim that fails twice, or
 * that the model gives up, stays as it was and is marked out of date by the assembly; a new claim
 * that fails twice is dropped and logged. A call that fails sets the page's `failure`, and the
 * caller stops the update. Nothing here touches the store.
 */
export async function rewritePages(
  input: RewriteInput,
  options: RewriteOptions,
): Promise<{ outcomes: RewriteOutcome[]; system: string; cacheKey: string | null }> {
  const log = options.log ?? (() => {});
  const batch = options.batch ?? true;
  const { index, manifest, sources, history } = input;
  const system = updateSystemPrompt(options.repoName, manifest);
  // Only unbatched calls share a cached prefix: a batch runs its requests concurrently, so most
  // of them write the prefix rather than read it (M6 gate (a) lost more than it saved).
  const cacheKey = !batch && input.rewrites.length >= 2 ? updateCacheKey(index.sha, system) : null;
  const symbols = new Map(index.files.map((f) => [f.path, f.symbols]));
  const ctx: VerifyContext = {
    sha: index.sha,
    sources,
    symbolsOf: (p) => symbols.get(p) ?? [],
    commits: history,
  };
  const states: State[] = input.rewrites.map((rewrite) => ({
    rewrite,
    pack: buildUpdatePack({
      rewrite,
      manifest,
      index,
      sources,
      ...(options.budgetTokens === undefined ? {} : { budgetTokens: options.budgetTokens }),
    }),
    rejected: null,
    answer: null,
    replaced: new Map(),
    given: new Set(),
    added: new Map(),
    failing: new Map(),
    diagram: null,
    failure: null,
    callFailed: false,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    model: null,
    calls: 0,
  }));
  const call = <T>(
    state: State,
    messages: LlmMessage[],
    schema: typeof UpdateDraft | typeof UpdateFixes,
    cached: boolean,
  ) =>
    settle<T>(
      options.provider.generate({
        purpose: "write",
        featureId: state.rewrite.featureId,
        system,
        messages,
        schema: schema as never,
        maxTokens: MAX_UPDATE_OUTPUT_TOKENS,
        ...(cached && cacheKey !== null ? { cacheKey } : {}),
        batch,
      }),
    );
  const take = (state: State, outcome: Settled<UpdateDraft>, retry = false) => {
    recordCall(state, outcome);
    if ("result" in outcome) {
      const claims = assignNewIds(state.rewrite, outcome.result.output.claims);
      state.answer = JSON.stringify({ ...outcome.result.output, claims });
      state.rejected = null;
      state.failing.clear();
      if (state.pack.candidates !== null) state.diagram = outcome.result.output.diagram;
      try {
        check(state, claims, ctx, null, log);
      } catch (error) {
        state.failure = `verifying the update failed: ${errorClass(error)}`;
      }
    } else if (outcome.error instanceof LlmOutputError) {
      state.rejected = rejectionOf(outcome.error);
    } else {
      state.failure = `the update call failed${retry ? " on the retry" : ""}: ${callFailure(outcome.error)}`;
      state.callFailed = true;
    }
  };

  // Round 1: one call per page, all issued by this one synchronous map.
  const first = await Promise.all(
    states.map((state) =>
      call<UpdateDraft>(state, [{ role: "user", content: state.pack.text }], UpdateDraft, true),
    ),
  );
  first.forEach((outcome, i) => {
    take(states[i] as State, outcome);
  });

  // Round 2: one retry per page that needs one, all in one tick; no cacheKey (spec §6.3).
  const retrying = states.filter(
    (s) => s.failure === null && (s.rejected !== null || s.failing.size > 0),
  );
  const second = await Promise.all(
    retrying.map((state) =>
      state.rejected !== null
        ? call<UpdateDraft>(
            state,
            retryRequest({
              pack: state.pack,
              draft: null,
              rejected: state.rejected,
              failing: new Map(),
            }),
            UpdateDraft,
            false,
          )
        : call<UpdateFixes>(state, fixRequest(state), UpdateFixes, false),
    ),
  );
  second.forEach((outcome, i) => {
    const state = retrying[i] as State;
    if (state.rejected !== null) {
      take(state, outcome as Settled<UpdateDraft>, true);
      return;
    }
    recordCall(state, outcome);
    if (!("result" in outcome)) {
      if (!(outcome.error instanceof LlmOutputError)) {
        state.failure = `the update call failed on the retry: ${callFailure(outcome.error)}`;
        state.callFailed = true;
      }
      return;
    }
    try {
      check(
        state,
        (outcome.result.output as UpdateFixes).claims,
        ctx,
        new Set(state.failing.keys()),
        log,
      );
    } catch (error) {
      state.failure = `verifying the update failed: ${errorClass(error)}`;
    }
  });

  const outcomes = states.map((state): RewriteOutcome => {
    const featureId = state.rewrite.featureId;
    const dropped = [...state.failing.values()]
      .filter((f) => !f.target)
      .map(({ key, claim, problems }) => ({ section: key, text: claim.text, problems }));
    for (const d of dropped)
      log(`${featureId}: dropped a new ${d.section} claim: ${d.problems.join("; ")}`);
    const keptStale = state.pack.targets.filter((id) => !state.replaced.has(id));
    for (const id of keptStale) log(`${featureId}: ${quote(id)} stays marked out of date`);
    return {
      featureId,
      pack: state.pack,
      replaced: state.replaced,
      keptStale,
      added: [...state.added.values()],
      dropped,
      diagram: state.diagram,
      calls: state.calls,
      tokens: state.tokens,
      model: state.model,
      failure: state.failure,
      callFailed: state.callFailed,
    };
  });
  return { outcomes, system, cacheKey };
}
