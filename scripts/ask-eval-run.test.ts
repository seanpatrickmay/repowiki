import { askIndexes } from "@repowiki/ask";
import { answerTurn, scriptedProvider, TURN_USAGE } from "@repowiki/ask/test-provider";
import { makeAskResponse } from "@repowiki/core/test-fixtures";
import type { EvalQuestion } from "@repowiki/eval";
import { callCostUsd, type GenerateRequest, LlmOutputError, type Provider } from "@repowiki/llm";
import { WikiView } from "@repowiki/query";
import { type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerText,
  groundedSentences,
  median,
  renderAskReport,
  runAskEval,
} from "./ask-eval-run.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

const QUESTIONS: EvalQuestion[] = [
  {
    id: "q-where",
    set: "dev",
    kind: "where",
    question: "Which function turns a chunk into signals?",
    reference: "ingest_chunk in src/signals/ingest.py.",
  },
  {
    id: "q-how",
    set: "dev",
    kind: "how",
    question: "How does ingest_chunk save each signal it makes?",
    reference: "With save_signal.",
  },
];

/** A judge that finds the reference's one fact when the answer names ingest_chunk. */
function fakeJudge() {
  const requests: GenerateRequest<unknown>[] = [];
  const judge: Provider = {
    async generate<T>(request: GenerateRequest<T>) {
      requests.push(request as GenerateRequest<unknown>);
      const turn = JSON.parse(request.messages[0]?.content ?? "{}") as { candidate: string };
      const present = turn.candidate.includes("ingest_chunk");
      const output = {
        facts: [{ fact: "ingest_chunk", essential: true, present }],
        contradicts: false,
        reason: present ? "Names the function." : "Does not name it.",
      } as T;
      return {
        output,
        usage: { in: 800, out: 100, cacheRead: 0, cacheWrite: 0 },
        model: "claude-haiku-4-5-20251001",
      };
    },
  };
  return { judge, requests };
}

describe("runAskEval", () => {
  const ANSWER = answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]);
  const run = (maxUsd = 1.5) => {
    const view = new WikiView(sample.wiki);
    const { provider, requests } = scriptedProvider([ANSWER, ANSWER]);
    const { judge, requests: judged } = fakeJudge();
    let now = 0;
    const result = runAskEval({
      view,
      indexes: askIndexes(view),
      questions: QUESTIONS,
      provider,
      judge,
      model: "claude-haiku-4-5",
      judgeModel: "claude-haiku-4-5",
      batchJudge: true,
      maxUsd,
      perQuestionCeilingUsd: [0.06, 0.06],
      clock: () => (now += 1500),
    });
    return { result, requests, judged };
  };

  it("asks every question, times it, and judges the answers in one batch", async () => {
    const { result, requests, judged } = run();
    const { rows, overBudget, spentUsd } = await result;
    expect(rows.map((r) => [r.id, r.response.status, r.score, r.ms])).toEqual([
      ["q-where", "answered", 1, 1500],
      ["q-how", "answered", 1, 1500],
    ]);
    expect(requests).toHaveLength(2);
    expect(judged).toHaveLength(2);
    expect(judged.every((r) => r.batch === true && r.purpose === "evalJudge")).toBe(true);
    expect(overBudget).toEqual([]);
    expect(spentUsd).toBeGreaterThan(0);
  });

  it("asks a question only while its ceiling fits under --max-usd", async () => {
    const { rows, overBudget } = await run(0.07).result;
    expect(rows.map((r) => r.id)).toEqual(["q-where"]);
    expect(overBudget).toEqual(["q-how"]);
  });

  it("stops at the first question that does not fit, so the asked questions are the file's first", async () => {
    const view = new WikiView(sample.wiki);
    const { provider, requests } = scriptedProvider([ANSWER, ANSWER, ANSWER]);
    const questions = [0, 1, 2].map((i) => ({ ...(QUESTIONS[0] as EvalQuestion), id: `q-${i}` }));
    const result = await runAskEval({
      view,
      indexes: askIndexes(view),
      questions,
      provider,
      judge: fakeJudge().judge,
      model: "claude-haiku-4-5",
      judgeModel: "claude-haiku-4-5",
      batchJudge: true,
      maxUsd: 0.2,
      // The second does not fit; the third, cheaper, would have.
      perQuestionCeilingUsd: [0.06, 0.5, 0.06],
    });
    expect(result.rows.map((r) => r.id)).toEqual(["q-0"]);
    expect(result.overBudget).toEqual(["q-1", "q-2"]);
    expect(requests).toHaveLength(1);
  });

  it("refuses a ceiling list that does not match the questions, before any call", async () => {
    const view = new WikiView(sample.wiki);
    const { provider, requests } = scriptedProvider([ANSWER, ANSWER]);
    await expect(
      runAskEval({
        view,
        indexes: askIndexes(view),
        questions: QUESTIONS,
        provider,
        judge: fakeJudge().judge,
        model: "claude-haiku-4-5",
        judgeModel: "claude-haiku-4-5",
        batchJudge: true,
        maxUsd: 1.5,
        perQuestionCeilingUsd: [0.06],
      }),
    ).rejects.toThrow("1 ceilings for 2 questions");
    expect(requests).toEqual([]);
  });

  it("counts exactly what the asks and the judgments cost", async () => {
    const { rows, spentUsd } = await run().result;
    const judgeUsd =
      callCostUsd(
        "claude-haiku-4-5-20251001",
        { in: 800, out: 100, cacheRead: 0, cacheWrite: 0 },
        true,
      ) ?? 0;
    expect(rows.map((r) => r.judgeUsd)).toEqual([judgeUsd, judgeUsd]);
    expect(spentUsd).toBeCloseTo(
      2 * (callCostUsd("claude-haiku-4-5-20251001", TURN_USAGE, false) ?? 0) + 2 * judgeUsd,
      12,
    );
  });

  const JUDGE_USAGE = { in: 800, out: 100, cacheRead: 0, cacheWrite: 0 };
  /** runAskEval over `count` copies of the first question, each answered, judged by `judge`. */
  const runWith = (judge: Provider, options: { count?: number; batchJudge?: boolean } = {}) => {
    const view = new WikiView(sample.wiki);
    const count = options.count ?? 2;
    const questions = Array.from({ length: count }, (_, i) => ({
      ...(QUESTIONS[0] as EvalQuestion),
      id: `q-${i}`,
    }));
    const { provider, requests } = scriptedProvider(Array(count).fill(ANSWER));
    const lines: string[] = [];
    const result = runAskEval({
      view,
      indexes: askIndexes(view),
      questions,
      provider,
      judge,
      model: "claude-haiku-4-5",
      judgeModel: "claude-haiku-4-5",
      batchJudge: options.batchJudge ?? true,
      maxUsd: 10,
      perQuestionCeilingUsd: questions.map(() => 0.06),
      log: (line) => lines.push(line),
    });
    return { result, requests, lines };
  };
  const ASK_USD = callCostUsd("claude-haiku-4-5-20251001", TURN_USAGE, false) ?? 0;

  it("counts a judgment that failed twice, logs it on one line and leaves it unjudged", async () => {
    const judge: Provider = {
      async generate() {
        throw new LlmOutputError("not JSON", "{", {
          usage: JUDGE_USAGE,
          model: "claude-haiku-4-5-20251001",
        });
      },
    };
    const { result, lines } = runWith(judge, { count: 1 });
    const { rows, spentUsd } = await result;
    const twice =
      callCostUsd("claude-haiku-4-5", { ...JUDGE_USAGE, in: 1600, out: 200 }, true) ?? 0;
    expect(rows[0]).toMatchObject({ score: null, judgeUsd: twice });
    expect(spentUsd).toBeCloseTo(ASK_USD + twice, 10);
    expect(lines.filter((l) => l.includes("q-0") && l.includes("unjudged"))).toHaveLength(1);
  });

  it("counts an unpriced judgment at the judge model's price", async () => {
    const judge: Provider = {
      async generate<T>() {
        const output = {
          facts: [{ fact: "x", essential: true, present: true }],
          contradicts: false,
          reason: "ok",
        } as T;
        return { output, usage: JUDGE_USAGE, model: "claude-unknown-9" };
      },
    };
    const { rows, spentUsd } = await runWith(judge, { count: 1 }).result;
    const usd = callCostUsd("claude-haiku-4-5", JUDGE_USAGE, true) ?? 0;
    expect(rows[0]?.judgeUsd).toBe(usd);
    expect(spentUsd).toBeCloseTo(ASK_USD + usd, 10);
  });

  it("rethrows a judge failure that is not an unusable answer, after the other judgments", async () => {
    let calls = 0;
    const { judge: good } = fakeJudge();
    const judge: Provider = {
      async generate(request) {
        if (++calls === 1) throw new Error("overloaded");
        return good.generate(request);
      },
    };
    await expect(runWith(judge).result).rejects.toThrow("overloaded");
    expect(calls).toBe(2);
  });

  it("with --no-batch, has at most four judge calls in flight", async () => {
    let inFlight = 0;
    let most = 0;
    const { judge: good } = fakeJudge();
    const judge: Provider = {
      async generate(request) {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return good.generate(request);
      },
    };
    const { rows } = await runWith(judge, { count: 7, batchJudge: false }).result;
    expect(rows).toHaveLength(7);
    expect(most).toBe(4);
  });

  it("refuses a question longer than the ask takes before any call", async () => {
    const view = new WikiView(sample.wiki);
    const { provider, requests } = scriptedProvider([ANSWER]);
    const { judge, requests: judged } = fakeJudge();
    const long = {
      ...(QUESTIONS[0] as EvalQuestion),
      id: "q-long",
      question: `${"x".repeat(500)}?`,
    };
    await expect(
      runAskEval({
        view,
        indexes: askIndexes(view),
        questions: [QUESTIONS[0] as EvalQuestion, long],
        provider,
        judge,
        model: "claude-haiku-4-5",
        judgeModel: "claude-haiku-4-5",
        batchJudge: true,
        maxUsd: 10,
        perQuestionCeilingUsd: [0.06, 0.06],
      }),
    ).rejects.toThrow(/at most 500 characters; longer: q-long$/);
    expect(requests).toEqual([]);
    expect(judged).toEqual([]);
  });

  it("records each question's result and spend as it completes, and the judged run last", async () => {
    const view = new WikiView(sample.wiki);
    const { provider } = scriptedProvider([ANSWER, ANSWER]);
    const records: { complete: boolean; rows: number; spentUsd: number }[] = [];
    const result = await runAskEval({
      view,
      indexes: askIndexes(view),
      questions: QUESTIONS,
      provider,
      judge: fakeJudge().judge,
      model: "claude-haiku-4-5",
      judgeModel: "claude-haiku-4-5",
      batchJudge: true,
      maxUsd: 10,
      perQuestionCeilingUsd: [0.06, 0.06],
      record: (progress) =>
        records.push({
          complete: progress.complete,
          rows: progress.rows.length,
          spentUsd: progress.spentUsd,
        }),
    });
    expect(records.map((r) => [r.complete, r.rows])).toEqual([
      [false, 1],
      [false, 2],
      [true, 2],
    ]);
    expect(records[0]?.spentUsd).toBeCloseTo(ASK_USD, 10);
    expect(records.at(-1)?.spentUsd).toBe(result.spentUsd);
  });

  it("records what a question that throws already spent before rethrowing", async () => {
    const view = new WikiView(sample.wiki);
    const broken = {
      content: null,
      stopReason: "tool_use",
      usage: TURN_USAGE,
      model: "claude-haiku-4-5-20251001",
    } as never;
    const { provider } = scriptedProvider([ANSWER, broken]);
    const records: { complete: boolean; rows: number; spentUsd: number }[] = [];
    await expect(
      runAskEval({
        view,
        indexes: askIndexes(view),
        questions: QUESTIONS,
        provider,
        judge: fakeJudge().judge,
        model: "claude-haiku-4-5",
        judgeModel: "claude-haiku-4-5",
        batchJudge: true,
        maxUsd: 10,
        perQuestionCeilingUsd: [0.06, 0.06],
        record: (progress) =>
          records.push({
            complete: progress.complete,
            rows: progress.rows.length,
            spentUsd: progress.spentUsd,
          }),
      }),
    ).rejects.toThrow();
    expect(records.at(-1)?.complete).toBe(false);
    expect(records.at(-1)?.rows).toBe(1);
    expect(records.at(-1)?.spentUsd).toBeCloseTo(2 * ASK_USD, 10);
  });

  it("rethrows the question's own failure when recording it fails too", async () => {
    const view = new WikiView(sample.wiki);
    const broken = {
      content: null,
      stopReason: "tool_use",
      usage: TURN_USAGE,
      model: "claude-haiku-4-5-20251001",
    } as never;
    const { provider } = scriptedProvider([broken]);
    const lines: string[] = [];
    let calls = 0;
    const failed = runAskEval({
      view,
      indexes: askIndexes(view),
      questions: QUESTIONS,
      provider,
      judge: fakeJudge().judge,
      model: "claude-haiku-4-5",
      judgeModel: "claude-haiku-4-5",
      batchJudge: true,
      maxUsd: 10,
      perQuestionCeilingUsd: [0.06, 0.06],
      log: (line) => lines.push(line),
      record: () => {
        calls++;
        throw new Error("ENOSPC: no space left on device");
      },
    });
    await expect(failed).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
    expect(lines.at(-1)).toBe(
      "could not record the run (ENOSPC: no space left on device); rethrowing the question's failure",
    );
  });

  it("gives the judge the sentences joined as one answer", () => {
    const response = { sentences: [{ text: "One." }, { text: "Two." }] };
    expect(answerText(response as never)).toBe("One. Two.");
  });
});

describe("groundedSentences", () => {
  it("counts the shown sentences whose sources were shown and whose names they write", () => {
    const view = new WikiView(sample.wiki);
    const source = (n: number, claimId: string) => ({
      n,
      pageId: "signals",
      pageTitle: "Signals",
      section: "overview",
      sectionTitle: "Overview",
      claimId,
      href: `/wiki/signals/#claim-${claimId}`,
      excerpt: "x",
    });
    const response = {
      status: "answered",
      sentences: [
        { text: "Signals are made by `ingest_chunk`.", sources: [1] },
        { text: "It is in `nowhere_at_all`.", sources: [1] },
        { text: "Ingestion stops at `MAX_SIGNALS`.", sources: [2] },
      ],
      sources: [source(1, "s-1"), source(2, "s-2")],
    } as never;
    expect(groundedSentences(view, response, ["signals#s-1"])).toBe(1);
    expect(groundedSentences(view, response, ["signals#s-1", "signals#s-2"])).toBe(2);
    expect(
      groundedSentences(view, { ...(response as object), status: "not-found" } as never, []),
    ).toBe(0);
  });
});

describe("renderAskReport", () => {
  it("states each question, the totals, the grounding and spec §12.5's bars", async () => {
    const view = new WikiView(sample.wiki);
    const { provider } = scriptedProvider([
      answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]),
      answerTurn([], "not-found"),
    ]);
    const result = await runAskEval({
      view,
      indexes: askIndexes(view),
      questions: QUESTIONS,
      provider,
      judge: fakeJudge().judge,
      model: "claude-haiku-4-5",
      judgeModel: "claude-haiku-4-5",
      batchJudge: true,
      maxUsd: 1.5,
      perQuestionCeilingUsd: [0.06, 0.06],
      clock: (() => {
        let t = 0;
        return () => (t += 3000);
      })(),
    });
    const report = renderAskReport({
      repo: "sample*<b>",
      head: sample.sha,
      model: "claude-haiku-4-5",
      set: "dev",
      startedAt: "2026-10-05T12:00:00.000Z",
      result,
    });
    expect(report).toContain(`# Ask eval: sample\\*\\<b\\> at ${sample.sha.slice(0, 7)}`);
    expect(report).toContain("| q-where | where | answered | yes | 1 | $0.0030 | 3.0 s |");
    expect(report).toContain("| q-how | how | not-found | no | 1 | $0.0030 | 3.0 s |");
    expect(report).toContain("- Accuracy: 1 of 2 (50%).");
    expect(result.rows.map((r) => r.grounded)).toEqual([1, 0]);
    expect(report).toContain(
      "- Grounding: 1 of 1 shown sentences cite only claims the model was shown and name only what they write (checked again from each question's shown handles).",
    );
    // A sentence the check finds ungrounded lowers the line: it is not the schema's guarantee.
    const [first, ...rest] = result.rows;
    if (first === undefined) throw new Error("no row");
    const lowered = renderAskReport({
      repo: "sample",
      head: sample.sha,
      model: "claude-haiku-4-5",
      set: "dev",
      startedAt: "2026-10-05T12:00:00.000Z",
      result: { ...result, rows: [{ ...first, grounded: 0 }, ...rest] },
    });
    expect(lowered).toContain("- Grounding: 0 of 1 shown sentences cite only claims");
    expect(report).toContain(
      "- Not answered (budget or error, each counted as not correct): none.",
    );
    expect(report).toContain("- Median cost at most $0.0150: met.");
    expect(report).toContain("- Median time at most 8 s: met.");
    expect(report).not.toContain("How does ingest_chunk save");
  });

  it("names the questions not answered or not asked, and says when a cost was counted at the cap", () => {
    const base = makeAskResponse();
    const row = (id: string, status: "answered" | "error" | "budget", usd: number | null) => ({
      id,
      kind: "where",
      question: "Placeholder question?",
      response:
        status === "answered"
          ? { ...base, cost: { turns: 1, usd, model: null } }
          : { ...base, status, sentences: [], sources: [], cost: { turns: 1, usd, model: null } },
      ms: 1000,
      score: status === "answered" ? (1 as const) : (0 as const),
      judgeUsd: 0.001,
      grounded: status === "answered" ? 2 : 0,
    });
    const report = renderAskReport({
      repo: "sample",
      head: sample.sha,
      model: "claude-haiku-4-5",
      set: "dev",
      startedAt: "2026-10-05T12:00:00.000Z",
      result: {
        rows: [row("q-1", "answered", null), row("q-2", "error", 0.001), row("q-3", "budget", 0)],
        overBudget: ["q-4", "q-5"],
        spentUsd: 0.06,
      },
    });
    expect(report).toContain(
      "- Not answered (budget or error, each counted as not correct): q-2 (error), q-3 (budget).",
    );
    expect(report).toContain(
      "- Not asked (the next question could have crossed --max-usd): q-4, q-5.",
    );
    expect(report).toContain("1 cost unknown, counted at the $0.0500 cap.");
  });

  it("finds the median of an odd and an even count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
