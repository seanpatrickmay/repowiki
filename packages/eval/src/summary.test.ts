import { WikiExport } from "@repowiki/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTokensOf, summarize, tokensOf } from "./summary.ts";
import { info, records } from "./test-records.ts";
import { type SampleWiki, sampleWiki } from "./test-wiki.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

describe("summarize", () => {
  it("states accuracy, tokens per question, the pass test and the break-even point", () => {
    const summary = summarize(info(), records());
    expect(summary.complete).toBe(true);
    expect(summary.agents.wiki).toEqual({
      answered: 4,
      judged: 4,
      correct: 3,
      accuracy: 0.75,
      tokensPerQuestion: 20_000,
      usdPerQuestion: 0.02,
      lastTurn: 0,
    });
    expect(summary.agents.repo).toMatchObject({
      correct: 4,
      accuracy: 1,
      tokensPerQuestion: 80_000,
      lastTurn: 1,
    });
    // 75% < 90% of 100%; 20,000 <= 40% of 80,000.
    expect(summary.pass).toEqual({ accuracy: false, tokens: true });
    expect(summary.breakEven).toBeCloseTo(1_000_000 / 60_000, 10);
  });

  it("states no pass test until every answer is judged, and no break-even without savings", () => {
    const partial = summarize(info(), records().slice(0, -1));
    expect(partial.complete).toBe(false);
    expect(partial.pass).toBeNull();
    expect(partial.agents.repo.accuracy).toBeNull();
    const costly = records().map((r) =>
      r.kind === "answer" && r.agent === "wiki" ? { ...r, usage: { ...r.usage, in: 200_000 } } : r,
    );
    expect(summarize(info(), costly).breakEven).toBe("never");
    expect(summarize(info({ buildTokens: null }), records()).breakEven).toBeNull();
  });
});

describe("buildTokensOf", () => {
  it("counts every token class of the newest build run in the export", () => {
    expect(buildTokensOf(sample.wiki)).toBe(30_000 + 6_000 + 9_000 + 5_000);
    const tokens = { in: 1, out: 1, cacheRead: 1, cacheWrite: 1 };
    const wiki = WikiExport.parse({
      ...sample.wiki,
      runs: [
        { kind: "build", sha: sample.sha, calls: 1, tokens },
        { kind: "update", sha: sample.sha, calls: 1, tokens: { ...tokens, in: 100 } },
      ],
    });
    expect(buildTokensOf(wiki)).toBe(4);
    expect(buildTokensOf(WikiExport.parse({ ...sample.wiki, runs: [] }))).toBeNull();
    expect(tokensOf(tokens)).toBe(4);
  });
});
