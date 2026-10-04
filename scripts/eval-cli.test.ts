import { join } from "node:path";
import { createRepoTools, createWikiTools, loadQuestions, selectQuestions } from "@repowiki/eval";
import { type SampleWiki, SMOKE_QUESTIONS, sampleWiki } from "@repowiki/eval/test-wiki";
import { DEFAULT_MODELS } from "@repowiki/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_USD,
  DEFAULT_TURN_LIMIT,
  EVAL_USAGE,
  estimateEval,
  estimateLine,
  parseEvalArgs,
  runDirFor,
} from "./eval-cli.ts";
import { CliError } from "./manifest-cli.ts";

describe("parseEvalArgs", () => {
  it("reads the repo, the question file, the set and the flags, with their defaults", () => {
    expect(parseEvalArgs(["../repo", "--questions", "q.json", "--set", "dev"])).toEqual({
      repo: "../repo",
      questions: "q.json",
      set: "dev",
      out: null,
      runDir: null,
      turnLimit: DEFAULT_TURN_LIMIT,
      maxUsd: DEFAULT_MAX_USD,
      config: null,
      batch: true,
      dryRun: false,
      verbose: false,
    });
    expect(
      parseEvalArgs([
        "r",
        "--set=smoke",
        "--questions=q.json",
        "--out",
        "o",
        "--run-dir",
        "d",
        "--turns",
        "8",
        "--max-usd",
        "1.5",
        "--no-batch",
        "--dry-run",
      ]),
    ).toMatchObject({
      out: "o",
      runDir: "d",
      turnLimit: 8,
      maxUsd: 1.5,
      batch: false,
      dryRun: true,
    });
  });

  it.each([
    [["r", "--questions", "q.json"], "--set must be dev, held-out or smoke"],
    [["r", "--questions", "q.json", "--set", "all"], "--set must be dev, held-out or smoke"],
    [["r", "--set", "dev"], "--questions is required"],
    [["r", "--questions", "q", "--set", "held-out", "--run-dir", "d"], "--run-dir cannot be given"],
    [["r", "--questions", "q", "--set", "dev", "--turns", "0"], "--turns must be a whole number"],
    [["r", "--questions", "q", "--set", "dev", "--turns", "2.5"], "--turns must be a whole number"],
    [["r", "--questions", "q", "--set", "dev", "--max-usd", "0"], "--max-usd must be a number"],
    [["r", "--questions", "q", "--set", "dev", "--max-usd=-1"], "--max-usd must be a number"],
    [["r", "--questions", "q", "--set", "dev", "--secret=sk-ant-x"], "bad option --secret"],
    [["r", "s", "--questions", "q", "--set", "dev"], "usage: pnpm eval:run"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseEvalArgs(argv)).toThrow(CliError);
    expect(() => parseEvalArgs(argv)).toThrow(message);
    expect(() => parseEvalArgs(argv)).not.toThrow(/sk-ant/);
  });

  it("ends every usage error with the usage line", () => {
    expect(() => parseEvalArgs([])).toThrow(EVAL_USAGE);
  });
});

describe("runDirFor", () => {
  const now = new Date("2026-10-04T12:30:00.000Z");
  it("keeps the held-out set in one place and gives any other run its own directory", () => {
    expect(runDirFor("/o", "held-out", null, now)).toBe(join("/o", "eval", "held-out"));
    expect(runDirFor("/o", "dev", null, now)).toBe(
      join("/o", "eval", "dev-2026-10-04T12-30-00-000Z"),
    );
    expect(runDirFor("/o", "smoke", "/runs/s", now)).toBe("/runs/s");
  });
});

describe("estimateEval", () => {
  let sample: SampleWiki;
  beforeAll(() => {
    sample = sampleWiki();
  });
  afterAll(() => sample.repo.remove());

  function input(overrides: Partial<Parameters<typeof estimateEval>[0]> = {}) {
    return {
      questions: selectQuestions(loadQuestions(SMOKE_QUESTIONS).file, "smoke"),
      repoName: "sample",
      turnLimit: 15,
      tools: {
        wiki: createWikiTools(sample.wiki).definitions,
        repo: createRepoTools(sample.repo.dir, sample.sha).definitions,
      },
      models: DEFAULT_MODELS,
      batchJudge: true,
      ...overrides,
    };
  }

  it("states a typical cost, a ceiling and the judge's cost", () => {
    const estimate = estimateEval(input());
    expect(estimate.questions).toBe(3);
    // Three questions: about $0.1 each for the repo agent's 8 turns and $0.03 for the wiki's 4.
    expect(estimate.agentsUsd).toBeGreaterThan(0.2);
    expect(estimate.agentsUsd).toBeLessThan(0.6);
    expect(estimate.ceilingUsd).toBeGreaterThan(5 * estimate.agentsUsd);
    expect(estimateEval(input({ batchJudge: false })).judgeUsd).toBeCloseTo(
      2 * estimate.judgeUsd,
      10,
    );
    expect(estimateEval(input({ turnLimit: 2 })).agentsUsd).toBeLessThan(estimate.agentsUsd);
  });

  it("refuses a model with no price before any call", () => {
    const models = { ...DEFAULT_MODELS, evalAgent: "claude-unknown-9" };
    expect(() => estimateEval(input({ models }))).toThrow(
      new CliError("no price for model claude-unknown-9; add it to packages/llm/src/pricing.ts"),
    );
  });

  it("refuses an unpriced judge model too, and never reports it as free", () => {
    const models = { ...DEFAULT_MODELS, evalJudge: "claude-unknown-9" };
    expect(() => estimateEval(input({ models }))).toThrow(
      new CliError("no price for model claude-unknown-9; add it to packages/llm/src/pricing.ts"),
    );
  });

  it("prints one line", () => {
    const line = estimateLine(estimateEval(input()), { turnLimit: 15, maxUsd: 5, batch: true });
    expect(line).toMatch(
      /^3 questions to both agents: about \$\d+\.\d\d \(assuming 4 wiki and 8 repo turns a question, no cache hits\), at most \$\d+\.\d\d if every question takes all 15 turns with full tool results; judging about \$\d+\.\d\d \(batched\); no question is asked once the run has spent \$5\.00 \(--max-usd\)$/,
    );
  });
});
