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
  plainWords,
  suggest,
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

describe("plainWords", () => {
  it("turns link tokens and Markdown into plain text within a limit", () => {
    expect(
      plainWords("The **[[ingest]]** step reads <script> files and [[wp:Unix|Unix]] pipes.", 200),
    ).toBe("The ingest step reads < script> files and Unix pipes.");
    expect(plainWords("one two three four", 9)).toBe("one two");
    expect(plainWords("# Title\n> quoted SIGNALS_TABLE", 200)).toBe("Title\nquoted SIGNALS_TABLE");
  });

  it("drops hidden characters and keeps at most three paragraphs", () => {
    expect(plainWords("a\u200Bb\u0007c\td", 200)).toBe("abc d");
    expect(plainWords("one\n\ntwo\n\nthree\n\nfour\n\nfive", 200)).toBe(
      "one\n\ntwo\n\nthree four five",
    );
  });
});

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
