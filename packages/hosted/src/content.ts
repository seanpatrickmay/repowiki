import { FeatureId, INVISIBLE_CHARACTERS } from "@repowiki/core";
import { z } from "zod";
import { MAX_TECHNOLOGIES, TechnologyUse } from "./detect.ts";

/** Control and invisible characters (core's shared rule), tested once with no global state. */
const INVISIBLE = new RegExp(INVISIBLE_CHARACTERS.source, "u");
/** An HTML tag, comment or declaration opening; a lone "<" in prose is fine. */
const MARKUP = /<[a-z!/?]/i;
export const MAX_PARAGRAPHS = 3;

/** Plain text shown on a project page (§8): no markup, no hidden characters, ≤ 3 paragraphs. */
export function plainText(max: number) {
  return z
    .string()
    .max(max)
    .refine((t) => !INVISIBLE.test(t.replace(/[\n\t]/g, "")), "control or invisible characters")
    .refine((t) => !MARKUP.test(t), "HTML is not allowed")
    .refine(
      (t) => t.trim().split(/\n[ \t]*\n\s*/).length <= MAX_PARAGRAPHS,
      `at most ${MAX_PARAGRAPHS} paragraphs`,
    );
}

const distinct = (values: readonly string[]) => new Set(values).size === values.length;
const count = z.int().nonnegative();

/** What a generation proposes; a revision's content is made from it (ADR-0012). */
export const Suggestions = z.strictObject({
  tagline: plainText(90),
  summary: plainText(900),
  contributionDraft: plainText(1200),
  highlightCandidates: z.array(FeatureId).max(6).refine(distinct, "duplicate feature"),
});
export type Suggestions = z.infer<typeof Suggestions>;

/** The author's git-history facts at the generation's commit (D2); the page always shows them. */
export const AuthorFacts = z
  .strictObject({
    commits: count,
    /** Others' commits naming the author in a Co-authored-by trailer, when any (ADR-0022). */
    coAuthored: z.int().positive().optional(),
    totalCommits: count,
    currentLines: count,
    totalLines: count,
    features: z.array(
      z.strictObject({ featureId: FeatureId, commits: count, currentLines: count }),
    ),
  })
  .refine(
    (a) => a.commits <= a.totalCommits && a.currentLines <= a.totalLines,
    "an author's share cannot exceed the total",
  );
export type AuthorFacts = z.infer<typeof AuthorFacts>;

export const Facts = z
  .strictObject({
    languages: z
      .array(z.strictObject({ name: z.string().min(1).max(40), share: z.number().min(0).max(1) }))
      .max(20),
    indexedFiles: count,
    featureIds: z.array(FeatureId).refine(distinct, "duplicate feature"),
    author: AuthorFacts,
    /** What the tree is built with (ADR-0014); generations stored before it have none. */
    technologies: z
      .array(TechnologyUse)
      .max(MAX_TECHNOLOGIES)
      .refine((ts) => distinct(ts.map((t) => t.id)), "duplicate technology")
      .default([]),
  })
  .refine((f) => f.languages.reduce((sum, l) => sum + l.share, 0) <= 1 + 1e-9, "shares over 1")
  .refine(
    (f) => f.author.features.every((a) => f.featureIds.includes(a.featureId)),
    "an author feature the wiki does not have",
  );
export type Facts = z.infer<typeof Facts>;

/**
 * What a revision publishes (ADR-0012): always generated, never edited by the author. Since
 * ADR-0013 it is the contribution only; the biography takes everything else from the export.
 */
export const PortfolioContent = z.strictObject({
  contribution: plainText(1200).refine((t) => t.trim() !== "", "empty contribution"),
});
export type PortfolioContent = z.infer<typeof PortfolioContent>;

/** The review declaration's wording by version; a Review records which one the author accepted. */
export const ATTESTATIONS = {
  1: "I reviewed this version. The contribution statement describes my own work accurately, and I checked the summary and highlights against the project.",
  2: "I reviewed this version. It describes my project and my part in it accurately.",
} as const;
/** What a review records now (ADR-0012): the author approves generated content, edits nothing. */
export const ATTESTATION_VERSION = 2;
