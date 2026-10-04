import { describe, expect, it } from "vitest";
import { judgeTurn, MAX_JUDGED_ANSWER_CHARS } from "./judge.ts";
import type { EvalQuestion } from "./questions.ts";
import { EvalRunError, type RunRecord } from "./records.ts";
import { SPOT_CHECK_SIZE, SpotCheck, spotCheckEntry, spotCheckSample } from "./spot-check.ts";
import { AT, answer, info, judgment, questions, records } from "./test-records.ts";

const many = (n: number): EvalQuestion[] =>
  Array.from({ length: n }, (_, i) => ({ ...questions[0], id: `q${i + 1}` })) as EvalQuestion[];

/** The agent behind each entry of a sample, as the report joins it back. */
const agentsOf = (startedAt: string, sample: SpotCheck) =>
  sample.answers.map((a) =>
    a.entry === spotCheckEntry(startedAt, a.questionId, "wiki") ? "wiki" : "repo",
  );

describe("spotCheckSample", () => {
  it("draws ten judgments, half from each agent, in an order fixed by the run", () => {
    const qs = many(10);
    const all = qs.flatMap((q) => [
      answer(q.id, "wiki", 1000),
      answer(q.id, "repo", 1000),
      judgment(q.id, "wiki", 1),
      judgment(q.id, "repo", 0),
    ]);
    const sample = spotCheckSample(info({ questions: qs }), all);
    expect(sample.answers).toHaveLength(SPOT_CHECK_SIZE);
    expect(agentsOf(info().startedAt, sample).filter((a) => a === "wiki")).toHaveLength(5);
    expect(sample.answers.every((j) => j.owner === null)).toBe(true);
    expect(spotCheckSample(info({ questions: qs }), [...all].reverse())).toEqual(sample);
    expect(spotCheckSample(info({ questions: qs, startedAt: AT }), all)).not.toEqual(sample);
    const entries = sample.answers.map((a) => a.entry);
    expect(entries).toEqual([...entries].sort());
  });

  it("is blind: no agent, no judge grade and no judge reason, but the run it came from", () => {
    const sample = spotCheckSample(info(), records());
    expect(SpotCheck.parse(sample)).toEqual(sample);
    expect(sample.run).toEqual({
      set: "held-out",
      repo: "sample",
      head: "a".repeat(40),
      startedAt: info().startedAt,
    });
    expect(sample.instructions).toContain('set "owner" to the number 1');
    expect(sample.instructions).toContain("the number 0");
    const text = JSON.stringify(sample.answers);
    for (const hidden of ["agent", "judgeScore", "judgeReason", "facts", "States the reference"]) {
      expect(text).not.toContain(hidden);
    }
    for (const a of sample.answers) expect(a.entry).toMatch(/^[0-9a-f]{16}$/);
  });

  it("takes what one agent lacks from the other, and every judgment when there are fewer", () => {
    const qs = many(20);
    const uneven = qs.flatMap((q, i) => [
      ...(i < 3 ? [answer(q.id, "wiki", 1000), judgment(q.id, "wiki", 1)] : []),
      answer(q.id, "repo", 1000),
      judgment(q.id, "repo", 1),
    ]);
    const sample = spotCheckSample(info({ questions: qs }), uneven);
    const agents = agentsOf(info().startedAt, sample);
    expect(agents.filter((a) => a === "wiki")).toHaveLength(3);
    expect(agents.filter((a) => a === "repo")).toHaveLength(7);
    const few = spotCheckSample(info(), records());
    expect(few.answers).toHaveLength(8);
    expect(new Set(agentsOf(info().startedAt, few))).toEqual(new Set(["wiki", "repo"]));
    expect(few.answers[0]?.answer).toContain("answer to");
  });

  it("draws the latest judgment of an answer once, and refuses one without its answer", () => {
    const twice: RunRecord[] = [...records(), judgment("q1", "wiki", 0)];
    const sample = spotCheckSample(info(), twice);
    expect(sample.answers).toHaveLength(8);
    expect(new Set(sample.answers.map((a) => a.entry)).size).toBe(8);
    const orphan = records().filter((r) => !(r.kind === "answer" && r.questionId === "q2"));
    expect(() => spotCheckSample(info(), orphan)).toThrow(EvalRunError);
    expect(() => spotCheckSample(info(), orphan)).toThrow(
      /^the run holds a judgment of "q2" \((wiki|repo)\) without its answer$/,
    );
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
    const recorded = [
      { ...answer(hostile.id, "wiki", 1000), answer: text },
      { ...answer(other.id, "wiki", 1000), answer: long },
      judgment(hostile.id, "wiki", 1),
      judgment(other.id, "wiki", 1),
    ];
    const sample = spotCheckSample(info({ questions: [hostile, other] }), recorded);
    expect(sample.answers).toHaveLength(2);
    for (const [q, raw] of [
      [hostile, text],
      [other, long],
    ] as const) {
      const seen = JSON.parse(judgeTurn(q, raw)) as {
        question: string;
        reference: string;
        candidate: string;
      };
      const shown = sample.answers.find((j) => j.questionId === q.id);
      expect(shown).toMatchObject({
        question: seen.question,
        reference: seen.reference,
        answer: seen.candidate,
      });
    }
    const first = sample.answers.find((j) => j.questionId === hostile.id);
    expect(first?.answer).toBe("The answer is a.ts \uFFFD ok");
    expect(first?.question).toBe("Where is it?");
    expect(first?.reference).toBe("In a.ts then b.ts\uFFFD.");
    const cut = sample.answers.find((j) => j.questionId === other.id);
    expect(cut?.answer.endsWith(`[cut at ${MAX_JUDGED_ANSWER_CHARS} characters]`)).toBe(true);
  });
});
