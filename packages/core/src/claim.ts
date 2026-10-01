import { z } from "zod";
import { Citation } from "./citation.ts";
import { GitSha } from "./primitives.ts";

export const ClaimKind = z.enum(["fact", "limitation", "history"]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const ClaimId = z.string().min(1);
export type ClaimId = z.infer<typeof ClaimId>;

export const Claim = z.object({
  id: ClaimId,
  /** Markdown with [[featureId]] / [[featureId|label]] / [[wp:Title]] link tokens. */
  text: z.string().min(1),
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
