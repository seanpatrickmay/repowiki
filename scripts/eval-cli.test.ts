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
  scoreLine,
} from "./eval-cli.ts";
import { CliError } from "./manifest-cli.ts";

describe("parseEvalArgs", () => {
  it("reads the repo, the question file, the set and the flags, with their defaults", () => {
    expect(parseEvalArgs(["../repo", "--questions", "q.json", "--set", "dev"])).toEqual({
      repo: "../repo",
      questions: "q.json",
      set: "dev",
      agents: null,
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
    expect(
      parseEvalArgs([
        "r",
        "--questions",
        "q",
        "--set",
        "dev",
        "--config",
        "c.json",
        "--verbose",
        "--max-usd",
        "100",
      ]),
    ).toMatchObject({ config: "c.json", verbose: true, maxUsd: 100 });
  });

  it.each([
    [["r", "--questions", "q.json"], "--set must be dev, held-out or smoke"],
    [["r", "--questions", "q.json", "--set", "all"], "--set must be dev, held-out or smoke"],
    [["r", "--questions", "q.json", "--set", "history"], "--set must be dev, held-out or smoke"],
    [["r", "--set", "dev"], "--questions is required"],
    [["r", "--questions", "q", "--set", "held-out", "--run-dir", "d"], "--run-dir cannot be given"],
    [
      ["r", "--questions", "q", "--set", "held-out", "--agents", "wiki"],
      "the held-out set is v1's single-use sign-off of the wiki and repo agents, so --agents can only be wiki,repo with it",
    ],
    [
      ["r", "--questions", "q", "--set", "held-out", "--agents", "repo"],
      "--agents can only be wiki,repo with it",
    ],
    [["r", "--questions", "q", "--set", "dev", "--turns", "0"], "--turns must be a whole number"],
    [["r", "--questions", "q", "--set", "dev", "--turns", "2.5"], "--turns must be a whole number"],
    [["r", "--questions", "q", "--set", "dev", "--max-usd", "0"], "--max-usd must be a number"],
    [["r", "--questions", "q", "--set", "dev", "--max-usd=-1"], "--max-usd must be a number"],
    [["r", "--questions", "q", "--set", "dev", "--secret=sk-ant-x"], "bad option --secret"],
    [["r", "s", "--questions", "q", "--set", "dev"], "usage: pnpm eval:run"],
    [["r", "--questions", "q", "--set", "dev", "--turns", "51"], "--turns must be a whole number"],
    [["r", "--questions", "q", "--set", "dev", "--max-usd", "abc"], "--max-usd must be a number"],
    [["r", "--questions", "q", "--set", "dev", "--max-usd", "1e3"], "--max-usd must be a number"],
    [
      ["r", "--questions", "q", "--set", "dev", "--max-usd", "100.01"],
      "--max-usd must be a number",
    ],
    [["r", "--questions", "q", "--set", "dev", "--out", ""], "--out must not be empty"],
    [["r", "--questions", "q", "--set", "dev", "--run-dir="], "--run-dir must not be empty"],
    [["r", "--questions", "q", "--set", "dev", "--config", ""], "--config must not be empty"],
    [["r", "--questions", "", "--set", "dev"], "--questions must not be empty"],
    [
      ["r", "--questions", "q", "--set", "dev", "--set", "held-out"],
      "--set was given more than once",
    ],
    [
      ["r", "--questions", "q", "--set", "dev", "--dry-run", "--dry-run"],
      "--dry-run was given more than once",
    ],
  ])("refuses %j", (argv, message) => {
    expect(() => parseEvalArgs(argv)).toThrow(CliError);
    expect(() => parseEvalArgs(argv)).toThrow(message);
    expect(() => parseEvalArgs(argv)).not.toThrow(/sk-ant/);
  });

  it("ends every usage error with the usage line", () => {
    expect(() => parseEvalArgs([])).toThrow(EVAL_USAGE);
  });
});

describe("parseEvalArgs and the held-out set", () => {
  it("runs the held-out set with its default agents, given or not", () => {
    const parse = (...more: string[]) =>
      parseEvalArgs(["r", "--questions", "q", "--set", "held-out", ...more]).agents;
    expect(parse()).toBeNull();
    expect(parse("--agents", "wiki,repo")).toEqual(["wiki", "repo"]);
    // The same two agents in another order are the same run, in v1's order.
    expect(parse("--agents", "repo,wiki")).toEqual(["wiki", "repo"]);
  });
});

describe("scoreLine", () => {
  const stats = (correct: number) => ({ correct });
  const agents = { wiki: stats(2), repo: stats(1) };
  it("names each asked agent's score, in the order asked", () => {
    const questions = [1, 2, 3];
    expect(scoreLine({ info: { agents: ["wiki", "repo"], questions }, agents })).toBe(
      "wiki 2 of 3, repo 1 of 3",
    );
    expect(scoreLine({ info: { agents: ["repo", "wiki"], questions }, agents })).toBe(
      "repo 1 of 3, wiki 2 of 3",
    );
    expect(scoreLine({ info: { agents: ["wiki"], questions }, agents })).toBe("wiki 2 of 3");
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
      agents: ["wiki", "repo"] as const,
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
    // The judge's ceiling: every judgment retried, each answer at the judge's cut.
    expect(estimate.judgeCeilingUsd).toBeGreaterThan(2 * estimate.judgeUsd);
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
      /^3 questions to the wiki and repo agents: about \$\d+\.\d\d \(wiki \$\d+\.\d\d at 4 turns, repo \$\d+\.\d\d at 8 turns a question, no cache hits\), at most \$\d+\.\d\d if every question takes all 15 turns with full tool results; judging about \$\d+\.\d\d \(batched\), at most \$\d+\.\d\d if every judgment is retried; no question is asked once the run has spent \$5\.00 \(--max-usd\)$/,
    );
    const short = estimateLine(estimateEval(input({ turnLimit: 3, batchJudge: false })), {
      turnLimit: 3,
      maxUsd: 5,
      batch: false,
    });
    expect(short).toMatch(
      /\(wiki \$\d+\.\d\d at 3 turns, repo \$\d+\.\d\d at 3 turns a question, no cache hits\)/,
    );
    expect(short).not.toContain("(batched)");
  });
});

describe("parseAgents", () => {
  it("reads --agents as a list of agent kinds, each once", () => {
    const parse = (agents: string) =>
      parseEvalArgs(["r", "--questions", "q", "--set", "dev", "--agents", agents]).agents;
    expect(parse("wiki,repo")).toEqual(["wiki", "repo"]);
    expect(parse(" repo , wiki ")).toEqual(["repo", "wiki"]);
    expect(parse("wiki")).toEqual(["wiki"]);
    expect(() => parse("wiki,mcp")).toThrow("--agents takes a comma-separated list of wiki, repo");
    expect(() => parse("repo,repo")).toThrow("--agents lists repo twice");
    expect(() => parse("")).toThrow(CliError);
  });
});
