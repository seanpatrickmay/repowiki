import { WikiExport } from "@repowiki/core";
import { Suggestions } from "@repowiki/hosted";
import type { GenerateRequest, GenerateResult, Provider } from "@repowiki/llm";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { buildFacts } from "./facts.ts";
import {
  cleanSuggestions,
  fallbackSuggestions,
  leadOf,
  suggest,
  taglineFrom,
} from "./suggestions.ts";

const exp = WikiExport.parse(fixtureExport());
const facts = buildFacts([{ language: "python", loc: 10, skipped: null }], exp);
const first = facts.featureIds[0] ?? "";

function provider(
  output: unknown,
  fail = false,
): Provider & { requests: GenerateRequest<unknown>[] } {
  const requests: GenerateRequest<unknown>[] = [];
  return {
    requests,
    async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
      requests.push(request as GenerateRequest<unknown>);
      if (fail) throw new Error("upstream refused");
      return {
        output: output as T,
        usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
        model: "claude-haiku-4-5",
      };
    },
  };
}

describe("suggestions (spec 2 §8)", () => {
  it("reads the About article's lead as plain text", () => {
    expect(leadOf(exp).length).toBeGreaterThan(0);
    expect(leadOf(exp)).not.toContain("[[");
  });

  it("asks once, with the About lead, feature titles and the author's counts", async () => {
    const p = provider({
      tagline: "A tool",
      summary: "It does things.",
      contributionDraft: "I built it.",
      highlightCandidates: [first],
    });
    const result = await suggest(p, exp, facts, "demo-dev");
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]?.purpose).toBe("write");
    const content = String(p.requests[0]?.messages[0]?.content);
    expect(content).toContain("demo-dev");
    expect(content).toContain(first);
    expect(content).toContain(leadOf(exp).slice(0, 20));
    expect(result).toEqual({
      suggestions: {
        tagline: "A tool",
        summary: "It does things.",
        contributionDraft: "I built it.",
        highlightCandidates: [first],
      },
      model: "claude-haiku-4-5",
    });
  });

  it("cleans markup, drops unknown and duplicate features, and keeps within the limits", () => {
    const cleaned = cleanSuggestions(
      {
        tagline: `<b>${"x".repeat(200)}</b>`,
        summary: "See [[ingest]].\n\n<script>alert(1)</script>",
        contributionDraft: "Mine.",
        highlightCandidates: [first, first, "not-a-feature"],
      },
      exp,
      facts,
    );
    expect(Suggestions.safeParse(cleaned).success).toBe(true);
    expect(cleaned.highlightCandidates).toEqual([first]);
    expect(cleaned.tagline.length).toBeLessThanOrEqual(90);
    expect(cleaned.summary).toContain("See ingest.");
    expect(cleaned.contributionDraft).toBe("Mine.");
  });

  it("falls back to suggestions made from the export when the call fails", async () => {
    const result = await suggest(provider(null, true), exp, facts, "demo-dev");
    expect(result.model).toBeNull();
    expect(result.suggestions).toEqual(fallbackSuggestions(exp, facts));
    expect(Suggestions.safeParse(result.suggestions).success).toBe(true);
    expect(result.suggestions.tagline.length).toBeGreaterThan(0);
  });
});

describe("taglineFrom (local feedback, 2026-10-15)", () => {
  it("keeps a short sentence whole, without its full stop", () => {
    expect(taglineFrom("A personal life dashboard for wellness and habits.")).toBe(
      "A personal life dashboard for wellness and habits",
    );
  });

  it("cuts a long sentence at its last clause or pause within the limit", () => {
    expect(
      taglineFrom(
        "AlphaSettler is a four-player Settlers of Catan bot that combines a Rust rules engine, information-set Monte Carlo tree search and a graph network.",
      ),
    ).toBe("AlphaSettler is a four-player Settlers of Catan bot that combines a Rust rules engine");
    expect(
      taglineFrom(
        "RotoText is a web application that uses eye tracking and geometric projection to let players align their gaze.",
      ),
    ).toBe("RotoText is a web application that uses eye tracking and geometric projection");
    expect(
      taglineFrom(
        "Generates a cited, feature-by-feature wiki for a git repo and updates it as the code changes",
      ),
    ).toBe("Generates a cited, feature-by-feature wiki for a git repo");
  });

  it("takes the first sentence of a long description", () => {
    expect(
      taglineFrom(
        "Tool to aid novice language speakers read books in their new dialect. AI powered vocab and reading comprehension quizzes, with sentence-by-sentence translation as needed.",
      ),
    ).toBe("Tool to aid novice language speakers read books in their new dialect");
  });

  it("ends a clause-less overlong text at a word, with an ellipsis", () => {
    const tagline = taglineFrom(`${"word ".repeat(40)}end`);
    expect(tagline.length).toBeLessThanOrEqual(90);
    expect(tagline.endsWith("word…")).toBe(true);
  });

  it("prefers the repository's own description over the wiki's lead", () => {
    const from = fallbackSuggestions(
      exp,
      facts,
      "Settlers of Catan AI: Rust engine, information-set MCTS",
    );
    expect(from.tagline).toBe("Settlers of Catan AI: Rust engine, information-set MCTS");
    expect(fallbackSuggestions(exp, facts, null).tagline).toBe(
      fallbackSuggestions(exp, facts).tagline,
    );
  });
});
