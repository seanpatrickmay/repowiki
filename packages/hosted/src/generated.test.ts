import { leadClaim, makeFeature, makeManifest, makeRevision } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { type Facts, PortfolioContent, type Suggestions } from "./content.ts";
import {
  contributionParagraph,
  documentationFeatures,
  generatedContent,
  generatedHighlights,
} from "./generated.ts";

/** A made-up wiki: three code features, a docs page by language and one by name. */
const page = (featureId: string, languages: string[], lead: string) =>
  makeRevision({
    id: `rev-${featureId}`,
    featureId,
    infobox: { ...makeRevision().infobox, languages },
    sections: [
      { key: "lead", claims: [leadClaim({ text: lead })] },
      ...makeRevision().sections.slice(1),
    ],
  });
const exp = {
  manifest: makeManifest({
    features: [
      makeFeature({ id: "cli", title: "CLI interface" }),
      makeFeature({ id: "arena", title: "Bot arena" }),
      makeFeature({ id: "perf", title: "Performance testing" }),
      makeFeature({ id: "notes", title: "Design notes" }),
      makeFeature({ id: "user-guide", title: "Getting started" }),
    ],
  }),
  pages: [
    page("cli", ["Python"], "The **[[cli]]** parses commands and runs a match between two bots."),
    page("arena", ["Python"], "The arena pits bots against each other."),
    page("perf", ["Python", "Shell"], "Performance testing times every engine move."),
    page("notes", ["Markdown"], "Notes on the design."),
    page("user-guide", ["Python"], "How to start."),
  ],
};
const facts = (author: Partial<Facts["author"]> = {}): Facts => ({
  languages: [{ name: "Python", share: 1 }],
  indexedFiles: 40,
  featureIds: ["cli", "arena", "perf", "notes", "user-guide"],
  author: {
    commits: 181,
    totalCommits: 181,
    currentLines: 9000,
    totalLines: 9000,
    features: [
      { featureId: "notes", commits: 90, currentLines: 100 },
      { featureId: "cli", commits: 60, currentLines: 4000 },
      { featureId: "arena", commits: 20, currentLines: 3000 },
      { featureId: "perf", commits: 11, currentLines: 1900 },
      { featureId: "user-guide", commits: 5, currentLines: 0 },
    ],
    ...author,
  },
});
const suggestions = (patch: Partial<Suggestions> = {}): Suggestions => ({
  tagline: "A bot arena",
  summary: "Bots play matches.",
  contributionDraft: "",
  highlightCandidates: ["perf", "notes", "arena", "cli", "user-guide"],
  ...patch,
});
const titles = new Map(exp.manifest.features.map((f) => [f.id as string, f.title]));

describe("documentation-like features (ADR-0012)", () => {
  it("are pages in prose formats only, or named for documentation", () => {
    expect([...documentationFeatures(exp)].sort()).toEqual(["notes", "user-guide"]);
  });
});

describe("generated highlights (ADR-0012)", () => {
  it("take up to 4 candidates by the author's commits, skipping documentation", () => {
    expect(generatedHighlights(suggestions(), facts(), exp)).toEqual([
      { featureId: "cli", blurb: "The cli parses commands and runs a match between two bots" },
      { featureId: "arena", blurb: "The arena pits bots against each other" },
      { featureId: "perf", blurb: "Performance testing times every engine move" },
    ]);
  });

  it("keep the candidates' order on equal commits and drop a candidate with no page", () => {
    const even = facts({ features: [] });
    const picked = generatedHighlights(
      suggestions({ highlightCandidates: ["perf", "gone", "arena", "cli"] }),
      { ...even, featureIds: [...even.featureIds, "gone"] },
      exp,
    );
    expect(picked.map((h) => h.featureId)).toEqual(["perf", "arena", "cli"]);
  });
});

describe("the generated contribution paragraph (ADR-0012)", () => {
  const docs = documentationFeatures(exp);

  it("states the author's share and their busiest code features", () => {
    expect(contributionParagraph("Ada Lovelace", facts(), titles, docs)).toBe(
      "Ada Lovelace wrote 181 of the repository's 181 commits and about 100% of its current lines, most of all in CLI interface, Bot arena and Performance testing.",
    );
  });

  it("drops the lines clause with no lines, and names fewer features when there are fewer", () => {
    const few = facts({
      commits: 3,
      totalCommits: 10,
      currentLines: 0,
      totalLines: 0,
      features: [{ featureId: "arena", commits: 3, currentLines: 0 }],
    });
    expect(contributionParagraph("ada", few, titles, docs)).toBe(
      "ada wrote 3 of the repository's 10 commits, most of all in Bot arena.",
    );
  });

  it("says when the history attributes no commits to the author", () => {
    const none = facts({ commits: 0, currentLines: 0, features: [] });
    expect(contributionParagraph("ada", none, titles, docs)).toBe(
      "The git history at this commit attributes none of the repository's 181 commits to ada.",
    );
  });
});

describe("generatedContent (ADR-0012)", () => {
  it("publishes the model's draft as written", () => {
    const draft = "Ada wrote the arena and the command line.";
    const content = generatedContent({
      suggestions: suggestions({ contributionDraft: draft }),
      facts: facts(),
      exp,
      authorName: "Ada Lovelace",
    });
    expect(PortfolioContent.parse(content)).toEqual({
      tagline: "A bot arena",
      summary: "Bots play matches.",
      contribution: draft,
      highlights: generatedHighlights(suggestions(), facts(), exp),
    });
  });

  it("falls back to the facts paragraph, with the name made plain", () => {
    const content = generatedContent({
      suggestions: suggestions({ contributionDraft: "  " }),
      facts: facts(),
      exp,
      authorName: "<b>Ada</b>",
    });
    expect(content.contribution).toMatch(/^< b>Ada< \/b> wrote 181 of/);
    expect(PortfolioContent.safeParse(content).success).toBe(true);
  });
});
