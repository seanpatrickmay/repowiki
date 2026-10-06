import type { EvalQuestion } from "@repowiki/eval";
import { describe, expect, it } from "vitest";
import { askEvalEstimateLine, estimateAskEval, parseAskEvalArgs } from "./ask-eval-cli.ts";
import { CliError } from "./manifest-cli.ts";

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

describe("parseAskEvalArgs", () => {
  it("defaults to the dev set, a $1.50 ceiling and a batched judge", () => {
    expect(parseAskEvalArgs(["../repo", "--questions", "q.json"])).toEqual({
      repo: "../repo",
      questions: "q.json",
      set: "dev",
      out: null,
      config: null,
      maxUsd: 1.5,
      batch: true,
      dryRun: false,
      baseline: true,
    });
    expect(parseAskEvalArgs(["r", "--questions", "q", "--no-baseline"]).baseline).toBe(false);
  });

  it("refuses the held-out set, saying why", () => {
    expect(() => parseAskEvalArgs(["r", "--questions", "q", "--set", "held-out"])).toThrow(
      /never runs the held-out set/,
    );
  });

  it.each([
    [["r"]],
    [["r", "--questions", "q", "--set", "history"]],
    [["r", "--questions", "q", "--max-usd", "0"]],
    [["r", "--questions", "q", "--max-usd", "21"]],
    [["r", "--questions", "q", "--questions", "p"]],
  ])("refuses %j", (argv) => {
    expect(() => parseAskEvalArgs(argv)).toThrow(CliError);
  });
});

describe("estimateAskEval", () => {
  it("adds the typical questions and their judging, and bounds every question at its cap", () => {
    const estimate = estimateAskEval({
      questions: QUESTIONS,
      typicalUsd: 0.01,
      judgeModel: "claude-haiku-4-5",
      batchJudge: true,
    });
    expect(estimate.askUsd).toBeCloseTo(0.02, 10);
    expect(estimate.judgeUsd).toBeGreaterThan(0);
    expect(estimate.judgeUsd).toBeLessThan(0.01);
    expect(estimate.perQuestionCeilingUsd).toHaveLength(2);
    expect(estimate.ceilingUsd).toBeGreaterThan(0.1);
    expect(askEvalEstimateLine(estimate, { set: "dev", maxUsd: 1.5, batch: true })).toMatch(
      /^2 dev questions through the ask: about \$0\.0\d \(asking \$0\.02, judging \$0\.00, batched\), at most \$0\.1\d if every question reaches its \$0\.05 cap and every judgment is retried; a question is asked only while it fits under \$1\.50 \(--max-usd\)$/,
    );
    expect(() =>
      estimateAskEval({ questions: QUESTIONS, typicalUsd: 0, judgeModel: "x-9", batchJudge: true }),
    ).toThrow(CliError);
  });
});
