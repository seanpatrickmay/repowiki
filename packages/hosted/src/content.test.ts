import { describe, expect, it } from "vitest";
import {
  ATTESTATION_VERSION,
  ATTESTATIONS,
  Facts,
  PortfolioContent,
  plainText,
} from "./content.ts";
import { aContent, aGeneration } from "./test-fixtures.ts";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("plain text (Contract spec §8)", () => {
  const text = plainText(20);

  it("accepts up to the limit, newlines and tabs, and up to three paragraphs", () => {
    expect(ok(text, "")).toBe(true);
    expect(ok(text, "x".repeat(20))).toBe(true);
    expect(ok(text, "a\tb\nc")).toBe(true);
    expect(ok(text, "a\n\nb\n\nc")).toBe(true);
  });

  it("refuses too long, four paragraphs, control or invisible characters, and HTML", () => {
    expect(ok(text, "x".repeat(21))).toBe(false);
    expect(ok(text, "a\n\nb\n\nc\n \nd")).toBe(false);
    expect(ok(text, "a\rb")).toBe(false);
    expect(ok(text, "a\u202eb")).toBe(false);
    expect(ok(text, "a\u200bb")).toBe(false);
    expect(ok(text, "<b>x</b>")).toBe(false);
    expect(ok(text, "<!-- x")).toBe(false);
    expect(ok(text, "a < b")).toBe(true);
  });
});

describe("portfolio content (ADR-0012, ADR-0013)", () => {
  it("is a non-empty contribution and nothing else", () => {
    const content = aContent();
    expect(ok(PortfolioContent, content)).toBe(true);
    expect(ok(PortfolioContent, { ...content, contribution: " " })).toBe(false);
    for (const gone of ["tagline", "summary", "highlights", "hiddenFeatureIds"]) {
      expect(ok(PortfolioContent, { ...content, [gone]: [] }), gone).toBe(false);
    }
  });
});

describe("facts (Contract spec §8)", () => {
  const facts = aGeneration().facts;

  it("accept a generation's facts", () => {
    expect(ok(Facts, facts)).toBe(true);
  });

  it("refuse an author share above the total, languages over 100% and unknown features", () => {
    expect(ok(Facts, { ...facts, author: { ...facts.author, commits: 621 } })).toBe(false);
    expect(ok(Facts, { ...facts, author: { ...facts.author, currentLines: 41_001 } })).toBe(false);
    const languages = [
      { name: "A", share: 0.6 },
      { name: "B", share: 0.6 },
    ];
    expect(ok(Facts, { ...facts, languages })).toBe(false);
    const features = [{ featureId: "elsewhere", commits: 1, currentLines: 1 }];
    expect(ok(Facts, { ...facts, author: { ...facts.author, features } })).toBe(false);
  });

  it("read stored facts without technologies as none, and bound them (ADR-0014)", () => {
    const { technologies: _, ...old } = facts;
    expect(Facts.parse(old).technologies).toEqual([]);
    const react = { id: "react", evidence: { path: "web/package.json" }, importingFiles: 3 };
    expect(Facts.parse({ ...facts, technologies: [react] }).technologies).toEqual([react]);
    expect(ok(Facts, { ...facts, technologies: [react, react] })).toBe(false);
    const many = Array.from({ length: 61 }, (_, i) => ({ ...react, id: `t-${i}` }));
    expect(ok(Facts, { ...facts, technologies: many })).toBe(false);
    const escaping = { ...react, evidence: { path: "../etc/passwd" } };
    expect(ok(Facts, { ...facts, technologies: [escaping] })).toBe(false);
  });
});

it("keeps attestation 1's wording and words attestation 2 for generated content (ADR-0012)", () => {
  expect(ATTESTATIONS[1]).toBe(
    "I reviewed this version. The contribution statement describes my own work accurately, and I checked the summary and highlights against the project.",
  );
  expect(ATTESTATIONS[2]).toBe(
    "I reviewed this version. It describes my project and my part in it accurately.",
  );
  expect(ATTESTATIONS[ATTESTATION_VERSION]).toBe(ATTESTATIONS[2]);
});
