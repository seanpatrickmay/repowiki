import { type Claim, CONTROL_CHARACTERS, type SectionKey, type TokenUsage } from "@repowiki/core";
import type { LlmMessage } from "@repowiki/llm";
import {
  type DraftClaim,
  LIMITATION_EVIDENCE_PROBLEM,
  type PageDraft,
  quote,
  type VerifyContext,
  verifyClaim,
} from "../verify/index.ts";
import type { ContextPack } from "./pack.ts";

/** Longest claim id the page keeps: what quote() shows whole, so a retry turn names it exactly. */
const MAX_ID_LENGTH = 80;
/** How many unknown supports a problem names before it says "and N more". */
const MAX_NAMED_SUPPORTS = 3;
/** The retry turn names this many failing claims, then "and N more claims failed". */
export const MAX_FIX_CLAIMS = 40;
/** The retry turn gives this many problems per claim, then "and N more". */
export const MAX_PROBLEMS_PER_CLAIM = 3;
/** The longest rejection reason the retry turn quotes, in code points. */
const MAX_REASON_LENGTH = 500;
/** Whitespace and core's CONTROL_CHARACTERS: a reason shows a run of them as a space. */
const REASON_BREAKS = new RegExp(`(?:\\s|${CONTROL_CHARACTERS.source})+`, "gu");

/** The first `max` characters of an id, never splitting a surrogate pair. */
function cut(id: string, max: number): string {
  // 2 * max code units hold at least max characters, so the slice bounds the work on a huge id.
  return [...id.slice(0, 2 * max)].slice(0, max).join("");
}

/**
 * The draft with its claim ids made unique on the page ("o1", then "o1-2"), sections and claims
 * in their original order (repeated and empty sections kept). The ids are the model's own
 * strings, so they are trimmed (a blank one becomes "claim") and cut to 80 characters before they
 * are made unique, and the work is linear in the number of claims. The draft is not changed.
 */
export function uniqueDraft(draft: PageDraft): PageDraft {
  const seen = new Set<string>();
  /** The next suffix to try for each base id, so a run of one id costs one step per claim. */
  const next = new Map<string, number>();
  const uniqueId = (raw: string): string => {
    const base = cut(raw.trim() || "claim", MAX_ID_LENGTH);
    let id = base;
    for (let n = next.get(base) ?? 2; seen.has(id); n++) {
      const suffix = `-${n}`;
      id = cut(base, MAX_ID_LENGTH - suffix.length) + suffix;
      next.set(base, n + 1);
    }
    seen.add(id);
    return id;
  };
  return {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      claims: section.claims.map((claim) => ({ ...claim, id: uniqueId(claim.id) })),
    })),
  };
}

/** A draft's claims with ids made unique on the page (see uniqueDraft), in section order. */
export function uniqueClaims(draft: PageDraft): { key: SectionKey; claim: DraftClaim }[] {
  return uniqueDraft(draft).sections.flatMap((section) =>
    section.claims.map((claim) => ({ key: section.key, claim })),
  );
}

/** Where one page stands between the write call and its retry. */
export interface PageState {
  pack: ContextPack;
  /**
   * The draft with uniqueDraft's ids, the ones `verified` and `failing` are named by, so the retry
   * turn shows the model the ids it is asked to fix.
   */
  draft: PageDraft | null;
  /** Raw answer text of an unusable first answer, and why it was unusable. */
  rejected: { text: string; reason: string } | null;
  failure: string | null;
  verified: Map<string, { key: SectionKey; claim: Claim }>;
  failing: Map<string, { key: SectionKey; claim: DraftClaim; problems: string[] }>;
  /** Failed claims no retry can fix, dropped without one (see setAsideUnfixable). */
  unfixable: Map<string, { key: SectionKey; claim: DraftClaim; problems: string[] }>;
  tokens: TokenUsage;
  model: string | null;
  calls: number;
}

export function newPageState(pack: ContextPack): PageState {
  return {
    pack,
    draft: null,
    rejected: null,
    failure: null,
    verified: new Map(),
    failing: new Map(),
    unfixable: new Map(),
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    model: null,
    calls: 0,
  };
}

/** The problem for lead supports that are not body claims of the page; each is named once. */
function unknownSupports(state: PageState, supports: readonly string[]): string[] {
  const unknown = [
    ...new Set(
      supports.filter((id) => {
        const target = state.verified.get(id) ?? state.failing.get(id) ?? state.unfixable.get(id);
        return target === undefined || target.key === "lead";
      }),
    ),
  ];
  if (unknown.length === 0) return [];
  const named = unknown.slice(0, MAX_NAMED_SUPPORTS).map((id) => quote(id));
  if (unknown.length > MAX_NAMED_SUPPORTS) {
    named.push(`and ${unknown.length - MAX_NAMED_SUPPORTS} more`);
  }
  return [`the lead supports ${named.join(", ")}, which are not body claims`];
}

/** Verifies a set of draft claims, lead claims last so their supports can be checked. */
export function verifyAll(
  state: PageState,
  claims: readonly { key: SectionKey; claim: DraftClaim }[],
  ctx: VerifyContext,
): void {
  const ordered = [...claims].sort((a, b) => Number(a.key === "lead") - Number(b.key === "lead"));
  for (const { key, claim } of ordered) {
    const checked = verifyClaim(key, claim, ctx);
    const problems = [...checked.problems];
    // Reported with the claim's other problems, so the retry turn lists everything at once.
    if (key === "lead") problems.push(...unknownSupports(state, claim.supports));
    if (checked.claim !== null && problems.length === 0) {
      state.failing.delete(claim.id);
      state.verified.set(claim.id, { key, claim: checked.claim });
    } else {
      state.failing.set(claim.id, { key, claim, problems });
    }
  }
}

/**
 * Moves each limitation claim whose only problem is missing evidence out of the retry round: a
 * retry cannot make the repository show a limitation, and re-sending the pack for it is most of
 * a build's retry cost. A page left with no other failing claim skips the retry.
 */
export function setAsideUnfixable(state: PageState): void {
  for (const [id, failed] of state.failing) {
    const [only, ...more] = failed.problems;
    if (
      failed.key === "known-limitations" &&
      only === LIMITATION_EVIDENCE_PROBLEM &&
      more.length === 0
    ) {
      state.failing.delete(id);
      state.unfixable.set(id, failed);
    }
  }
}

/** The retry turn for a page with failing claims: the pack, the draft, and the first problems. */
export function fixRequest(state: PageState): LlmMessage[] {
  if (state.draft === null) throw new Error("fixRequest needs the page's draft");
  if (state.failing.size === 0) throw new Error("fixRequest needs a failing claim");
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
    { role: "assistant", content: JSON.stringify(uniqueDraft(state.draft)) },
    {
      role: "user",
      content: `These claims failed verification:\n${listed.join("\n")}\nReturn corrected versions of only these claims, under the same ids, citing only lines and commits the pack shows. You may give up any claim you cannot support from the pack: return a body claim with an empty cite list, or a lead claim with an empty supports list.`,
    },
  ];
}

/** A rejection reason as one line of at most 500 characters. */
function oneLine(reason: string): string {
  const line = reason.replace(REASON_BREAKS, " ").trim();
  const chars = [...line.slice(0, 2 * MAX_REASON_LENGTH)];
  return chars.length <= MAX_REASON_LENGTH && line.length <= 2 * MAX_REASON_LENGTH
    ? line
    : `${chars.slice(0, MAX_REASON_LENGTH - 1).join("")}…`;
}

/** The retry turn for a page whose first answer was unusable (spec §6.3: retry once). */
export function retryRequest(state: PageState): LlmMessage[] {
  const { rejected } = state;
  if (rejected === null) throw new Error("retryRequest needs the rejected answer");
  return [
    { role: "user", content: state.pack.text },
    { role: "assistant", content: rejected.text.trim() === "" ? "(no answer)" : rejected.text },
    {
      role: "user",
      content: `That answer was rejected: ${oneLine(rejected.reason)}\nReturn the corrected JSON object.`,
    },
  ];
}
