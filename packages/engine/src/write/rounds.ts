import type { Claim, SectionKey, TokenUsage } from "@repowiki/core";
import type { LlmMessage } from "@repowiki/llm";
import {
  type DraftClaim,
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

/** The first `max` characters of an id, never splitting a surrogate pair. */
function cut(id: string, max: number): string {
  // 2 * max code units hold at least max characters, so the slice bounds the work on a huge id.
  return [...id.slice(0, 2 * max)].slice(0, max).join("");
}

/**
 * A draft's claims with ids made unique on the page ("o1", then "o1-2"), in section order. The
 * ids are the model's own strings, so they are trimmed (a blank one becomes "claim") and cut to 80
 * characters before they are made unique, and the work is linear in the number of claims.
 */
export function uniqueClaims(draft: PageDraft): { key: SectionKey; claim: DraftClaim }[] {
  const seen = new Set<string>();
  /** The next suffix to try for each base id, so a run of one id costs one step per claim. */
  const next = new Map<string, number>();
  const out: { key: SectionKey; claim: DraftClaim }[] = [];
  for (const section of draft.sections) {
    for (const claim of section.claims) {
      const base = cut(claim.id.trim() || "claim", MAX_ID_LENGTH);
      let id = base;
      for (let n = next.get(base) ?? 2; seen.has(id); n++) {
        const suffix = `-${n}`;
        id = cut(base, MAX_ID_LENGTH - suffix.length) + suffix;
        next.set(base, n + 1);
      }
      seen.add(id);
      out.push({ key: section.key, claim: { ...claim, id } });
    }
  }
  return out;
}

/** Where one page stands between the write call and its retry. */
export interface PageState {
  pack: ContextPack;
  /**
   * The draft as the retry turn re-sends it, verbatim. The ids of `failing` are named to the
   * model, so keep the draft's own ids equal to them (uniqueClaims makes them unique).
   */
  draft: PageDraft | null;
  /** Raw answer text of an unusable first answer, and why it was unusable. */
  rejected: { text: string; reason: string } | null;
  failure: string | null;
  verified: Map<string, { key: SectionKey; claim: Claim }>;
  failing: Map<string, { key: SectionKey; claim: DraftClaim; problems: string[] }>;
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
        const target = state.verified.get(id) ?? state.failing.get(id);
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

/** The retry turn for a page with failing claims: the pack, the draft, and every problem. */
export function fixRequest(state: PageState): LlmMessage[] {
  const listed = [...state.failing.values()].map(
    ({ claim, problems }) => `- ${quote(claim.id)}: ${problems.join("; ")}`,
  );
  return [
    { role: "user", content: state.pack.text },
    { role: "assistant", content: JSON.stringify(state.draft) },
    {
      role: "user",
      content: `These claims failed verification:\n${listed.join("\n")}\nReturn corrected versions of only these claims, under the same ids, citing only lines and commits the pack shows. To give up a claim the pack cannot support, return it with an empty cite list.`,
    },
  ];
}

/** The retry turn for a page whose first answer was unusable (spec §6.3: retry once). */
export function retryRequest(state: PageState): LlmMessage[] {
  const rejected = state.rejected ?? { text: "", reason: "" };
  return [
    { role: "user", content: state.pack.text },
    { role: "assistant", content: rejected.text.trim() === "" ? "(no answer)" : rejected.text },
    {
      role: "user",
      content: `That answer was rejected: ${rejected.reason}\nReturn the corrected JSON object.`,
    },
  ];
}
