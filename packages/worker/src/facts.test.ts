import { WikiExport } from "@repowiki/core";
import { Facts } from "@repowiki/hosted";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { authorFacts, buildFacts, indexedCount, languageShares, pageFeatureIds } from "./facts.ts";

const file = (
  language: string | null,
  loc: number,
  skipped: "binary" | "too-large" | null = null,
) => ({ language, loc, skipped });

describe("generation facts (spec 2 §8, Contract §8)", () => {
  it("counts the files the engine indexed, not the skipped ones", () => {
    expect(indexedCount([file("python", 10), file(null, 5), file(null, 0, "binary")])).toBe(2);
  });

  it("gives languages by share of indexed lines, merging TSX into TypeScript, never over 1", () => {
    const shares = languageShares([
      file("typescript", 300),
      file("tsx", 100),
      file("python", 333),
      file(null, 267),
      file("rust", 9999, "too-large"),
    ]);
    expect(shares).toEqual([
      { name: "TypeScript", share: 0.4 },
      { name: "Python", share: 0.333 },
    ]);
    expect(shares.reduce((s, l) => s + l.share, 0)).toBeLessThanOrEqual(1);
    expect(languageShares([])).toEqual([]);
  });

  it("takes the author's facts from the People snapshot, keeping only the wiki's features", () => {
    const snapshot = {
      commits: 20,
      totalLines: 600,
      people: [
        {
          id: "author",
          commits: 12,
          currentLines: 340,
          features: [
            { featureId: "ingest", commits: 7, currentLines: 200 },
            { featureId: "gone", commits: 1, currentLines: 5 },
          ],
        },
      ],
    };
    expect(authorFacts(snapshot, ["ingest", "search"])).toEqual({
      commits: 12,
      totalCommits: 20,
      currentLines: 340,
      totalLines: 600,
      features: [{ featureId: "ingest", commits: 7, currentLines: 200 }],
    });
  });

  it("carries the commits that name the author as a co-author (ADR-0022)", () => {
    const snapshot = {
      commits: 20,
      totalLines: 600,
      people: [{ id: "author", commits: 4, coAuthored: 3, currentLines: 40, features: [] }],
    };
    expect(authorFacts(snapshot, [])).toMatchObject({ commits: 4, coAuthored: 3 });
    expect(
      authorFacts(
        { ...snapshot, people: [{ ...snapshot.people[0], coAuthored: undefined }] } as never,
        [],
      ),
    ).not.toHaveProperty("coAuthored");
  });

  it("gives zeros when there is no snapshot or the author is not in it", () => {
    const zero = { commits: 0, totalCommits: 0, currentLines: 0, totalLines: 0, features: [] };
    expect(authorFacts(null, ["x"])).toEqual(zero);
    expect(authorFacts({ commits: 5, totalLines: 50, people: [] }, ["x"])).toEqual({
      ...zero,
      totalCommits: 5,
      totalLines: 50,
    });
  });

  it("builds Facts that pass the Contract's schema from a real export", () => {
    const exp = WikiExport.parse(fixtureExport());
    const facts = buildFacts([file("python", 120)], exp);
    expect(Facts.safeParse(facts).success).toBe(true);
    expect(facts.featureIds).toEqual(pageFeatureIds(exp));
    expect(facts.featureIds.length).toBeGreaterThan(0);
    expect(facts.indexedFiles).toBe(1);
    expect(facts.technologies).toEqual([]);
    const react = { id: "react", evidence: { path: "package.json" }, importingFiles: 2 };
    expect(buildFacts([file("python", 120)], exp, [react]).technologies).toEqual([react]);
  });
});
