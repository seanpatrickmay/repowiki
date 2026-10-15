import { FeatureId, INVISIBLE_CHARACTERS } from "@repowiki/core";
import { z } from "zod";

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

/** What a generation proposes; the author's overrides replace any of it (§8). */
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
  })
  .refine((f) => f.languages.reduce((sum, l) => sum + l.share, 0) <= 1 + 1e-9, "shares over 1")
  .refine(
    (f) => f.author.features.every((a) => f.featureIds.includes(a.featureId)),
    "an author feature the wiki does not have",
  );
export type Facts = z.infer<typeof Facts>;

/** What a revision publishes (ADR-0012): always generated, never edited by the author. */
export const PortfolioContent = z.strictObject({
  tagline: plainText(90),
  summary: plainText(900),
  contribution: plainText(1200).refine((t) => t.trim() !== "", "empty contribution"),
  highlights: z
    .array(z.strictObject({ featureId: FeatureId, blurb: plainText(140) }))
    .max(4)
    .refine((h) => distinct(h.map((x) => x.featureId)), "duplicate highlight"),
});
export type PortfolioContent = z.infer<typeof PortfolioContent>;

/** The portfolio layer an author edits (§8); a missing tagline or summary uses the suggestion. */
export const Overrides = z
  .strictObject({
    tagline: plainText(90).optional(),
    summary: plainText(900).optional(),
    contribution: plainText(1200),
    highlights: z.array(z.strictObject({ featureId: FeatureId, blurb: plainText(140) })).max(4),
  })
  .refine((o) => distinct(o.highlights.map((h) => h.featureId)), "duplicate highlight");
export type Overrides = z.infer<typeof Overrides>;

export const EMPTY_OVERRIDES: Overrides = {
  contribution: "",
  highlights: [],
};

/** The review declaration's wording by version; a Review records which one the author accepted. */
export const ATTESTATIONS = {
  1: "I reviewed this version. The contribution statement describes my own work accurately, and I checked the summary and highlights against the project.",
} as const;
export const ATTESTATION_VERSION = 1;
