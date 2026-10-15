import type { WikiExport } from "@repowiki/core";
import { type Facts, PortfolioContent, type Suggestions } from "./content.ts";
import { firstClause, plainWords } from "./text.ts";

/** The parts of an export the generated content reads. */
export type ContentExport = Pick<WikiExport, "manifest" | "pages">;

/** Infobox languages that are prose, not code. */
const PROSE = new Set(["AsciiDoc", "Markdown", "reStructuredText", "Text"]);
/** Words that name documentation in a feature's title or id. */
const DOCS =
  /\b(?:docs?|documentation|readme|changelog|guides?|manuals?|tutorials?|specs?|specifications?|adrs?)\b/i;
const BLURB_MAX = 140;
const HIGHLIGHTS = 4;
const MOST_OF_ALL = 3;
const TITLE_MAX = 80;

const titlesOf = (exp: ContentExport) =>
  new Map(exp.manifest.features.map((f) => [f.id as string, f.title]));

/**
 * The features whose pages document the project rather than build it (ADR-0012): every infobox
 * language a prose format, or a title or id that names documentation.
 */
export function documentationFeatures(exp: ContentExport): Set<string> {
  const titles = titlesOf(exp);
  return new Set(
    exp.pages
      .filter((page) => {
        const { languages } = page.infobox;
        if (languages.length > 0 && languages.every((l) => PROSE.has(l))) return true;
        const title = titles.get(page.featureId) ?? "";
        return DOCS.test(title) || DOCS.test(page.featureId.replace(/-/g, " "));
      })
      .map((page) => page.featureId as string),
  );
}

/** Commits by feature, most first; ties keep `ids`' order (sort is stable). */
function byCommits(ids: readonly string[], facts: Facts): string[] {
  const commits = new Map(facts.author.features.map((f) => [f.featureId as string, f.commits]));
  return [...ids].sort((a, b) => (commits.get(b) ?? 0) - (commits.get(a) ?? 0));
}

/**
 * Up to 4 of the candidates that have a page, by the author's commits, documentation left out;
 * each blurb is the page's lead cut at a clause (ADR-0012).
 */
export function generatedHighlights(
  suggestions: Suggestions,
  facts: Facts,
  exp: ContentExport,
): PortfolioContent["highlights"] {
  const pages = new Map(exp.pages.map((p) => [p.featureId as string, p]));
  const docs = documentationFeatures(exp);
  const candidates = suggestions.highlightCandidates.filter((id) => pages.has(id) && !docs.has(id));
  return byCommits(candidates, facts)
    .slice(0, HIGHLIGHTS)
    .map((featureId) => {
      const lead = pages.get(featureId)?.sections.find((s) => s.key === "lead");
      const text = (lead?.claims ?? []).map((c) => c.text).join(" ");
      return { featureId, blurb: firstClause(text, BLURB_MAX) };
    });
}

const listed = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The contribution paragraph when no model wrote one (ADR-0012): the author's share of commits
 * and current lines, and their busiest features that are not documentation.
 */
export function contributionParagraph(
  name: string,
  facts: Facts,
  titles: ReadonlyMap<string, string>,
  docs: ReadonlySet<string>,
): string {
  const a = facts.author;
  const total = `${a.totalCommits} commit${a.totalCommits === 1 ? "" : "s"}`;
  if (a.commits === 0) {
    return `The git history at this commit attributes none of the repository's ${total} to ${name}.`;
  }
  const share = Math.round((a.currentLines / Math.max(a.totalLines, 1)) * 100);
  const lines =
    a.totalLines === 0
      ? ""
      : ` and about ${share === 0 && a.currentLines > 0 ? "under 1" : share}% of its current lines`;
  const busiest = byCommits(
    a.features.filter((f) => f.commits > 0 && !docs.has(f.featureId)).map((f) => f.featureId),
    facts,
  )
    .slice(0, MOST_OF_ALL)
    // A title is the model's words: made plain and short, so the paragraph is valid content.
    .map((id) => plainWords(titles.get(id) ?? "", TITLE_MAX) || id);
  const where = busiest.length === 0 ? "" : `, most of all in ${listed(busiest)}`;
  return `${name} wrote ${a.commits} of the repository's ${total}${lines}${where}.`;
}

export interface ContentInput {
  suggestions: Suggestions;
  facts: Facts;
  exp: ContentExport;
  authorName: string;
}

/**
 * The published contribution (ADR-0012): the model's draft as written, or else the facts
 * paragraph. The one place it is made, for the project page and any later per-project section.
 */
export function generatedContribution(input: ContentInput): string {
  const draft = input.suggestions.contributionDraft.trim();
  if (draft !== "") return draft;
  const name = plainWords(input.authorName, 100) || "The author";
  const { exp } = input;
  return contributionParagraph(name, input.facts, titlesOf(exp), documentationFeatures(exp));
}

/**
 * A revision's content from its generation (ADR-0012): the suggested tagline and summary, the
 * generated contribution and the generated highlights.
 */
export function generatedContent(input: ContentInput): PortfolioContent {
  const { suggestions, facts, exp } = input;
  return PortfolioContent.parse({
    tagline: suggestions.tagline,
    summary: suggestions.summary,
    contribution: generatedContribution(input),
    highlights: generatedHighlights(suggestions, facts, exp),
  });
}
