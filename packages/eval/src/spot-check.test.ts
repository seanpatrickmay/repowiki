import { describe, expect, it } from "vitest";
import { judgeTurn, MAX_JUDGED_ANSWER_CHARS } from "./judge.ts";
import type { EvalQuestion } from "./questions.ts";
import { SPOT_CHECK_SIZE, spotCheckSample } from "./spot-check.ts";
import { AT, answer, info, judgment, questions, records } from "./test-records.ts";

describe("spotCheckSample", () => {
  it("draws ten judgments, half from each agent, in an order fixed by the run", () => {
    const many: EvalQuestion[] = Array.from({ length: 10 }, (_, i) => ({
      ...questions[0],
      id: `q${i + 1}`,
    })) as EvalQuestion[];
    const all = many.flatMap((q) => [
      answer(q.id, "wiki", 1000),
      answer(q.id, "repo", 1000),
      judgment(q.id, "wiki", 1),
      judgment(q.id, "repo", 0),
    ]);
    const sample = spotCheckSample(info({ questions: many }), all);
    expect(sample.judgments).toHaveLength(SPOT_CHECK_SIZE);
    expect(sample.judgments.filter((j) => j.agent === "wiki")).toHaveLength(5);
    expect(sample.judgments.every((j) => j.owner === null)).toBe(true);
    expect(spotCheckSample(info({ questions: many }), [...all].reverse())).toEqual(sample);
    expect(spotCheckSample(info({ questions: many, startedAt: AT }), all)).not.toEqual(sample);
    const few = spotCheckSample(info(), records());
    expect(few.judgments).toHaveLength(8);
    expect(few.judgments[0]).toMatchObject({
      answer: expect.stringContaining("answer to"),
      reference: expect.any(String),
    });
  });

  it("shows the owner exactly the text the judge received", () => {
    const hostile: EvalQuestion = {
      ...questions[0],
      question: "Where\u202E is it\u200B?",
      reference: "In a.ts\u2028then b.ts\u{E0041}\u0007.",
    } as EvalQuestion;
    const text = `The answer\u202E is\u200B a.ts\u2066\uFEFF\u2028\u{E0049}\u{E0067}\u0007 ok`;
    const long = `${"x".repeat(MAX_JUDGED_ANSWER_CHARS)}\u200B${"y".repeat(50)}`;
    const other: EvalQuestion = { ...questions[1], id: "q2" } as EvalQuestion;
    const records = [
      { ...answer(hostile.id, "wiki", 1000), answer: text },
      { ...answer(other.id, "wiki", 1000), answer: long },
      judgment(hostile.id, "wiki", 1),
      judgment(other.id, "wiki", 1),
    ];
    const sample = spotCheckSample(info({ questions: [hostile, other] }), records);
    expect(sample.judgments).toHaveLength(2);
    for (const [q, raw] of [
      [hostile, text],
      [other, long],
    ] as const) {
      const seen = JSON.parse(judgeTurn(q, raw)) as {
        question: string;
        reference: string;
        candidate: string;
      };
      const shown = sample.judgments.find((j) => j.questionId === q.id);
      expect(shown).toMatchObject({
        question: seen.question,
        reference: seen.reference,
        answer: seen.candidate,
      });
    }
    const first = sample.judgments.find((j) => j.questionId === hostile.id);
    expect(first?.answer).toBe("The answer is a.ts \uFFFD ok");
    expect(first?.question).toBe("Where is it?");
    expect(first?.reference).toBe("In a.ts then b.ts\uFFFD.");
    const cut = sample.judgments.find((j) => j.questionId === other.id);
    expect(cut?.answer.endsWith(`[cut at ${MAX_JUDGED_ANSWER_CHARS} characters]`)).toBe(true);
  });
});
