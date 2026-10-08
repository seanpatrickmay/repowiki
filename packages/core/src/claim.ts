import { z } from "zod";
import { Citation } from "./citation.ts";
import { GitSha } from "./primitives.ts";

export const ClaimKind = z.enum(["fact", "limitation", "history"]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const ClaimId = z.string().min(1);
export type ClaimId = z.infer<typeof ClaimId>;

/**
 * Longest claim text, in UTF-16 code units. The reader renders claim text on articles, old
 * revisions, previews and the Main Page, and its inline renderer is quadratic on adversarial
 * input, so text is capped well above any real claim (M5 final review). It shipped before the
 * first claim producer (M4's write step), so no stored body can break it and no migration is needed.
 */
export const CLAIM_TEXT_MAX_LENGTH = 2000;

export const Claim = z.object({
  id: ClaimId,
  /** Markdown with [[featureId]] / [[featureId|label]] / [[wp:Title]] link tokens. */
  text: z.string().min(1).max(CLAIM_TEXT_MAX_LENGTH),
  kind: ClaimKind,
  citations: z.array(Citation),
  /** Lead claims only: ids of the body claims this sentence summarizes. */
  supports: z.array(ClaimId),
  /** Set when an update could not re-verify this claim; the reader shows an out-of-date banner. */
  staleSince: GitSha.nullable(),
  /** Candidate for the Main Page "Did you know…" list. */
  hook: z.boolean(),
});
export type Claim = z.infer<typeof Claim>;

const ANCHORED_CLAIM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The id of a claim's anchor on the site (`claim-<id>`, spec v2 #4 R17), or null when the id is
 * not one an HTML id and a URL fragment can carry as written; such a claim links to its section.
 */
export function claimAnchor(claimId: string): string | null {
  return ANCHORED_CLAIM_ID.test(claimId) ? `claim-${claimId}` : null;
}
