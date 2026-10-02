import { z } from "zod";
import { Claim } from "./claim.ts";
import { FeatureId } from "./feature.ts";
import { GitSha, IsoDateTime } from "./primitives.ts";
import { RevisionReason, TokenUsage } from "./revision.ts";
import { addSectionStructureIssues, addUpdateParentIssue } from "./revision-rules.ts";

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

const DUPLICATE_PAGE = "a claim names the same page twice";

/**
 * A claim of the Architecture article. Besides citations, a body claim may name the feature
 * pages that back it: their leads are what the claim summarizes, and those leads rest on cited
 * body claims (spec §5 rule 2), so the chain of support still ends in code.
 */
export const ArchitectureClaim = Claim.extend({
  /** Body claims only: ids of features whose pages back the claim. */
  pages: z.array(FeatureId).max(MAX_CLAIM_PAGES),
}).refine((claim) => new Set(claim.pages).size === claim.pages.length, DUPLICATE_PAGE);
export type ArchitectureClaim = z.infer<typeof ArchitectureClaim>;

/** Every rule an Architecture claim breaks in a section (spec §7.4). */
export function architectureClaimViolations(
  key: ArchitectureSectionKey,
  claim: ArchitectureClaim,
): string[] {
  const violations: string[] = [];
  if (claim.kind !== "fact") violations.push("architecture claims must be fact claims");
  if (new Set(claim.pages).size !== claim.pages.length) violations.push(DUPLICATE_PAGE);
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

const ARTICLE_ID = /^architecture-[0-9a-f]{12}-[1-9][0-9]*$/;

/**
 * One revision of the Architecture article (F27): how the features fit together. It is not a
 * feature page, so it has no feature id, infobox or See also; it lives at /special/architecture/.
 */
export const Architecture = z
  .object({
    /** `architecture-<sha12>-<n>`: the first 12 characters of `sha`, then the 1-based position. */
    id: z.string().regex(ARTICLE_ID, "expected an id like architecture-<sha12>-<n>"),
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
    if (!article.id.startsWith(`architecture-${article.sha.slice(0, 12)}-`)) {
      ctx.addIssue({
        code: "custom",
        message: "the id must carry the first 12 characters of the sha",
        path: ["id"],
      });
    }
    addSectionStructureIssues(article.sections, ctx);
    if (article.basis.some((id, i) => i > 0 && id <= (article.basis[i - 1] ?? ""))) {
      ctx.addIssue({
        code: "custom",
        message: "basis must be sorted without repeats",
        path: ["basis"],
      });
    }
    const weights = article.edges.map((edge) => edge.imports + edge.calls);
    if (weights.some((weight, i) => i > 0 && weight > (weights[i - 1] ?? 0))) {
      ctx.addIssue({
        code: "custom",
        message: "edges must be heaviest first",
        path: ["edges"],
      });
    }
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
    addUpdateParentIssue(article, ctx);
  });
export type Architecture = z.infer<typeof Architecture>;
