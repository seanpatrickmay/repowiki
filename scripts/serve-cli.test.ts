import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliError } from "./manifest-cli.ts";
import {
  parseWikiServeArgs,
  serveEstimateLine,
  siteIsCurrent,
  totalsLine,
  typicalQuestionUsd,
} from "./serve-cli.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

describe("parseWikiServeArgs", () => {
  it("takes the repo and defaults the port, the caps and asking", () => {
    expect(parseWikiServeArgs(["../repo"])).toEqual({
      repo: "../repo",
      out: null,
      port: 4321,
      repoUrl: null,
      config: null,
      questionUsd: 0.05,
      maxUsd: 1,
      ask: true,
    });
    expect(
      parseWikiServeArgs([
        "r",
        "--port",
        "0",
        "--question-usd",
        "0.1",
        "--max-usd",
        "2",
        "--no-ask",
      ]),
    ).toMatchObject({ port: 0, questionUsd: 0.1, maxUsd: 2, ask: false });
  });

  it.each([
    [[]],
    [["a", "b"]],
    [["r", "--port", "65536"]],
    [["r", "--port", "-1"]],
    [["r", "--port", "80.5"]],
    [["r", "--question-usd", "0"]],
    [["r", "--question-usd", "1.5"]],
    [["r", "--max-usd", "21"]],
    [["r", "--max-usd", "0.01"]],
    [["r", "--max-usd", "1e1"]],
    [["r", "--out", "a", "--out", "b"]],
    [["r", "--out="]],
    [["r", "--host", "0.0.0.0"]],
  ])("refuses %j", (argv) => {
    expect(() => parseWikiServeArgs(argv)).toThrow(CliError);
  });

  it("never echoes a bad option's value", () => {
    expect(() => parseWikiServeArgs(["r", "--key=sk-ant-secret"])).toThrow(/bad option --key;/);
    expect(() => parseWikiServeArgs(["r", "--key=sk-ant-secret"])).not.toThrow(/sk-ant/);
  });
});

describe("siteIsCurrent", () => {
  it("is true only for a marked site whose export copy is the one a build writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-serve-site-"));
    try {
      expect(siteIsCurrent(dir, sample.wiki)).toBe(false);
      writeFileSync(join(dir, "export.json"), `${JSON.stringify(sample.wiki, null, 2)}\n`);
      expect(siteIsCurrent(dir, sample.wiki)).toBe(false);
      writeFileSync(join(dir, ".repowiki-site"), "");
      expect(siteIsCurrent(dir, sample.wiki)).toBe(true);
      expect(siteIsCurrent(dir, { ...sample.wiki, exportedAt: "2027-01-01T00:00:00Z" })).toBe(
        false,
      );
      writeFileSync(join(dir, "export.json"), JSON.stringify(sample.wiki));
      expect(siteIsCurrent(dir, sample.wiki)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the estimate line, the typical question and the totals line", () => {
  it("states the model, the typical cost and both caps", () => {
    expect(
      serveEstimateLine({
        model: "claude-haiku-4-5",
        typicalUsd: 0.0089,
        questionUsd: 0.05,
        maxUsd: 1,
      }),
    ).toBe(
      "ask: claude-haiku-4-5, about $0.01 a question, at most $0.05 a question and $1.00 this session",
    );
    expect(totalsLine({ questions: 12, cached: 3, usd: 0.1104 })).toBe(
      "12 questions, 3 cached, $0.1104",
    );
    expect(totalsLine({ questions: 1, cached: 0, usd: 0 })).toBe("1 question, 0 cached, $0.0000");
  });

  it("prices a typical question from the export's median page, and refuses an unpriced model", () => {
    const usd = typicalQuestionUsd(sample.wiki, "claude-haiku-4-5");
    expect(usd).toBeGreaterThan(0.003);
    expect(usd).toBeLessThan(0.02);
    expect(() => typicalQuestionUsd(sample.wiki, "claude-unknown-9")).toThrow(CliError);
  });
});
