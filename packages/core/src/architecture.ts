import { z } from "zod";
import { Claim } from "./claim.ts";
import { FeatureId } from "./feature.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { RevisionReason, TokenUsage } from "./revision.ts";

/** Sections of the Architecture article (F27), in page order. */
export const ArchitectureSectionKey = z.enum([
  "lead",
  "layers",
  "request-paths",
  "dependencies",
  "infrastructure",
]);
export type ArchitectureSectionKey = z.infer<typeof ArchitectureSectionKey>;

/** The most feature pages one claim may name as its support. */
export const MAX_CLAIM_PAGES = 3;

/**
 * A claim of the Architecture article. Besides citations, a body claim may name the feature
 * pages that back it: their leads are what the claim summarizes, and those leads rest on cited
 * body claims (spec §5 rule 2), so the chain of support still ends in code.
 */
export const ArchitectureClaim = Claim.extend({
  /** Body claims only: ids of features whose pages back the claim. */
  pages: z.array(FeatureId).max(MAX_CLAIM_PAGES),
});
export type ArchitectureClaim = z.infer<typeof ArchitectureClaim>;

/** Every rule an Architecture claim breaks in a section (spec §7.4). */
export function architectureClaimViolations(
  key: ArchitectureSectionKey,
  claim: ArchitectureClaim,
): string[] {
  const violations: string[] = [];
  if (claim.kind !== "fact") violations.push("architecture claims must be fact claims");
  if (new Set(claim.pages).size !== claim.pages.length) {
    violations.push("a claim names the same page twice");
  }
  if (key === "lead") {
    if (claim.citations.length > 0 || claim.pages.length > 0) {
      violations.push("lead claims carry no citations or pages; list the body claims they support");
    }
    if (claim.supports.length === 0) {
      violations.push("lead claims must support at least one body claim");
    }
    return violations;
  }
  if (claim.supports.length > 0) violations.push("only lead claims may support other claims");
  if (claim.citations.length === 0 && claim.pages.length === 0) {
    violations.push("body claims need a citation or a feature page");
  }
  if (key === "request-paths" && claim.citations.length === 0) {
    violations.push("request-path claims need a code or commit citation");
  }
  return violations;
}

export const ArchitectureSection = z
  .object({ key: ArchitectureSectionKey, claims: z.array(ArchitectureClaim).min(1) })
  .superRefine((section, ctx) => {
    section.claims.forEach((claim, index) => {
      for (const message of architectureClaimViolations(section.key, claim)) {
        ctx.addIssue({ code: "custom", message, path: ["claims", index] });
      }
    });
  });
export type ArchitectureSection = z.infer<typeof ArchitectureSection>;

const count = z.int().nonnegative();

/** Import and call edges from one feature's files into another's, as the index counts them. */
export const FeatureEdge = z
  .object({ from: FeatureId, to: FeatureId, imports: count, calls: count })
  .refine((edge) => edge.from !== edge.to, "an edge joins two different features")
  .refine((edge) => edge.imports + edge.calls > 0, "an edge needs an import or a call");
export type FeatureEdge = z.infer<typeof FeatureEdge>;

/**
 * One revision of the Architecture article (F27): how the features fit together. It is not a
 * feature page, so it has no feature id, infobox or See also; it lives at /special/architecture/.
 */
export const Architecture = z
  .object({
    id: z.string().min(1),
    sha: GitSha,
    commitDate: IsoDateTime,
    generatedAt: IsoDateTime,
    parentId: z.string().min(1).nullable(),
    reason: RevisionReason,
    pr: z.int().positive().nullable(),
    model: z.string().min(1),
    tokens: TokenUsage,
    /** Ids of the feature page revisions the article was written from, sorted. */
    basis: z.array(z.string().min(1)),
    /** Cross-feature edges among the features of `basis`, heaviest first. */
    edges: z.array(FeatureEdge),
    /** Mermaid source of the feature diagram, or null. */
    diagram: z.string().min(1).nullable(),
    sections: z.array(ArchitectureSection).min(1),
  })
  .superRefine((article, ctx) => {
    if (article.sections[0]?.key !== "lead") {
      ctx.addIssue({
        code: "custom",
        message: "the first section must be the lead",
        path: ["sections", 0],
      });
    }
    const keys = new Set<string>();
    const ids = new Set<string>();
    const bodyIds = new Set<string>();
    article.sections.forEach((section, s) => {
      if (keys.has(section.key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate section ${section.key}`,
          path: ["sections", s],
        });
      }
      keys.add(section.key);
      section.claims.forEach((claim, c) => {
        if (ids.has(claim.id)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate claim id ${claim.id}`,
            path: ["sections", s, "claims", c],
          });
        }
        ids.add(claim.id);
        if (section.key !== "lead") bodyIds.add(claim.id);
      });
    });
    article.sections.forEach((section, s) => {
      if (section.key !== "lead") return;
      section.claims.forEach((claim, c) => {
        for (const supported of claim.supports) {
          if (!bodyIds.has(supported)) {
            ctx.addIssue({
              code: "custom",
              message: `lead claim ${claim.id} supports unknown body claim ${supported}`,
              path: ["sections", s, "claims", c, "supports"],
            });
          }
        }
      });
    });
    const pairs = new Set<string>();
    article.edges.forEach((edge, e) => {
      const pair = `${edge.from}>${edge.to}`;
      if (pairs.has(pair)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate edge ${edge.from} -> ${edge.to}`,
          path: ["edges", e],
        });
      }
      pairs.add(pair);
    });
    if (article.reason === "update" && article.parentId === null) {
      ctx.addIssue({
        code: "custom",
        message: "update revisions must have a parent",
        path: ["parentId"],
      });
    }
  });
export type Architecture = z.infer<typeof Architecture>;
