import { z } from "zod";
import { Claim, type ClaimKind } from "./claim.ts";

/** Stored sections. "See also" and "References" are rendered from Revision.seeAlso and citations. */
export const SectionKey = z.enum([
  "lead",
  "overview",
  "how-it-works",
  "data-flow",
  "history",
  "known-limitations",
]);
export type SectionKey = z.infer<typeof SectionKey>;

function expectedKind(key: SectionKey): ClaimKind {
  if (key === "history") return "history";
  if (key === "known-limitations") return "limitation";
  return "fact";
}

/** Every citation-rule violation for one claim in a section (spec §5, rules 2–4). */
export function claimRuleViolations(key: SectionKey, claim: Claim): string[] {
  const violations: string[] = [];
  const kind = expectedKind(key);
  if (claim.kind !== kind) violations.push(`${key} claims must be ${kind} claims`);

  if (key === "lead") {
    if (claim.citations.length > 0) {
      violations.push("lead claims carry no citations; cite the body claims they support");
    }
    if (claim.supports.length === 0)
      violations.push("lead claims must support at least one body claim");
    return violations;
  }

  if (claim.supports.length > 0) violations.push("only lead claims may support other claims");
  if (claim.citations.length === 0) violations.push("body claims need at least one citation");
  if (claim.kind === "history" && !claim.citations.some((c) => c.kind === "commit")) {
    violations.push("history claims need a commit citation");
  }
  return violations;
}

export const Section = z
  .object({ key: SectionKey, claims: z.array(Claim).min(1) })
  .superRefine((section, ctx) => {
    section.claims.forEach((claim, index) => {
      for (const message of claimRuleViolations(section.key, claim)) {
        ctx.addIssue({ code: "custom", message, path: ["claims", index] });
      }
    });
  });
export type Section = z.infer<typeof Section>;
