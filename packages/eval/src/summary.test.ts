import { WikiExport } from "@repowiki/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvalQuestion } from "./questions.ts";
import type { RunRecord } from "./records.ts";
import { buildTokensOf, summarize, tokensOf } from "./summary.ts";
import { answer, info, judgment, questions, records } from "./test-records.ts";
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
    // Equal tokens save nothing: never.
    const equal = records().map((r) =>
      r.kind === "answer"
        ? { ...r, usage: { in: 9000, out: 1000, cacheRead: 0, cacheWrite: 0 } }
        : r,
    );
    expect(summarize(info(), equal).breakEven).toBe("never");
  });

  it("states the break-even only once every answer is judged", () => {
    expect(summarize(info(), records().slice(0, -1)).breakEven).toBeNull();
  });

  /** n questions; each agent's answers with the given total tokens, and its correct count. */
  function run(n: number, wiki: [number, number], repo: [number, number]): RunRecord[] {
    const qs = Array.from({ length: n }, (_, i) => `q${i + 1}`);
    const tokens = (total: number, i: number) => Math.floor(total / n) + (i < total % n ? 1 : 0);
    return qs.flatMap((id, i) => [
      {
        ...answer(id, "wiki", 1000),
        usage: { in: tokens(wiki[0], i), out: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        ...answer(id, "repo", 1000),
        usage: { in: tokens(repo[0], i), out: 0, cacheRead: 0, cacheWrite: 0 },
      },
      judgment(id, "wiki", i < wiki[1] ? 1 : 0),
      judgment(id, "repo", i < repo[1] ? 1 : 0),
    ]);
  }
  const of = (n: number) =>
    info({
      questions: Array.from({ length: n }, (_, i) => ({
        ...questions[0],
        id: `q${i + 1}`,
      })) as EvalQuestion[],
    });

  it("meets both conditions at exactly 90% and 40%, in whole numbers", () => {
    expect(summarize(of(10), run(10, [4000, 9], [10_000, 10])).pass).toEqual({
      accuracy: true,
      tokens: true,
    });
    expect(summarize(of(10), run(10, [4001, 8], [10_000, 10])).pass).toEqual({
      accuracy: false,
      tokens: false,
    });
    // 3,094 / 30 <= 0.4 * 7,735 / 30 is false in floating point, but 5 * 3,094 = 2 * 7,735.
    expect(summarize(of(30), run(30, [3094, 27], [7735, 30])).pass).toEqual({
      accuracy: true,
      tokens: true,
    });
  });

  it("states no pass test when the repo agent answered nothing correctly", () => {
    const zero = summarize(of(10), run(10, [1000, 0], [10_000, 0]));
    expect(zero.complete).toBe(true);
    expect(zero.pass).toBeNull();
  });

  it("counts a failed judgment's cost as the judge's, and an unknown cost as unknown", () => {
    const failed: RunRecord = {
      kind: "judge-failure",
      questionId: "q1",
      agent: "repo",
      reason: "unusable twice",
      usage: { in: 1000, out: 200, cacheRead: 0, cacheWrite: 0 },
      usd: 0.001,
      model: "claude-haiku-4-5",
      batch: true,
      at: "2026-10-04T12:30:00.000Z",
    };
    const summary = summarize(info(), [...records(), failed]);
    expect(summary.judgeUsd).toBeCloseTo(8 * 0.0005 + 0.001, 10);
    expect(summary.complete).toBe(true);
    const unknown = records().map((r, i) => (i === 0 ? { ...r, usd: null } : r));
    const blind = summarize(info(), unknown);
    expect(blind.agentUsd).toBeNull();
    expect(blind.agents.wiki.usdPerQuestion).toBeNull();
    expect(blind.agents.repo.usdPerQuestion).toBeCloseTo(0.08, 10);
    expect(blind.judgeUsd).toBeCloseTo(8 * 0.0005, 10);
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
