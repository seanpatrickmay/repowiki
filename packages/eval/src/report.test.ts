import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvalRunError, openRun, RESULTS_FILE, type RunRecord } from "./records.ts";
import { REPORT_FILE, renderReport, writeReport } from "./report.ts";
import { SPOT_CHECK_FILE, SpotCheck, spotCheckSample } from "./spot-check.ts";
import { summarize } from "./summary.ts";
import { info, records } from "./test-records.ts";

describe("renderReport", () => {
  it("reports both agents, the pass test, the break-even point and each question", () => {
    const text = renderReport(summarize(info(), records()), records(), null);
    expect(text).toContain(
      [
        "| Agent | Correct | Accuracy | Tokens per question | Cost per question | Answered on the last turn |",
        "|---|---:|---:|---:|---:|---:|",
        "| wiki | 3 of 4 | 75% | 20,000 | $0.0200 | 0 |",
        "| repo | 4 of 4 | 100% | 80,000 | $0.0800 | 1 |",
      ].join("\n"),
    );
    expect(text).toContain(
      [
        "- Accuracy: the wiki agent's 75% against at least 90% (90% of the repo agent's 100%): not met.",
        "- Tokens: the wiki agent's 20,000 per question against at most 32,000 (40% of the repo agent's 80,000): met.",
        "",
        "Result on this set: fail.",
      ].join("\n"),
    );
    expect(text).toContain(
      "The build cost 1,000,000 tokens. Each question answered from the wiki instead of the code saves 60,000 tokens, so the build pays for itself after 17 questions (1,000,000 / 60,000).",
    );
    expect(text).toContain("| q1 | where | 1 | 1 | 20,000 | 110,000 | 3 | 3 |");
    expect(text).toContain("The author wrote the questions on 2026-10-01, by his statement.");
    // A model's reason stays inside its line and cannot split a table row.
    expect(text).toContain("  - wiki (0): Names \\| another file.");
    expect(text).toContain("Agents $0.4000, judge $0.0040: $0.4040 in all");
  });

  it("says a run is incomplete, and what a dev or smoke set is for", () => {
    const partial = renderReport(
      summarize(info(), records().slice(0, -1)),
      records().slice(0, -1),
      null,
    );
    expect(partial).toContain("Incomplete: 0 answers and 1 judgments missing.");
    expect(partial).not.toContain("## Pass test");
    const dev = renderReport(summarize(info({ set: "dev" }), records()), records(), null);
    expect(dev).toContain("This is the dev set: its figures track progress.");
    const smoke = renderReport(
      summarize(info({ set: "smoke", writtenOn: null }), records()),
      records(),
      null,
    );
    expect(smoke).toContain("It measures nothing.");
  });
  it("is counted in the report once the owner marks it", () => {
    const check = spotCheckSample(info(), records());
    check.judgments[0] = { ...(check.judgments[0] as (typeof check.judgments)[0]), owner: 1 };
    const first = check.judgments[1] as (typeof check.judgments)[0];
    check.judgments[1] = { ...first, owner: first.judgeScore === 1 ? 0 : 1 };
    const text = renderReport(summarize(info(), records()), records(), check);
    expect(text).toContain("The owner marked 2 of 8 judgments in spot-check.json and agrees with");
    expect(text).toContain(`- Disagrees on ${first.questionId} (${first.agent})`);
  });
});

describe("the owner's agreement with the judge", () => {
  const resultScore = (j: { questionId: string; agent: string }) => {
    const found = records().find(
      (r) => r.kind === "judgment" && r.questionId === j.questionId && r.agent === j.agent,
    );
    return found?.kind === "judgment" ? found.score : null;
  };

  it("follows results.jsonl, not the judge's grade copied into spot-check.json", () => {
    const check = spotCheckSample(info(), records());
    // The file's copy of the judge's grade is flipped on every entry; the owner marks the real grade.
    check.judgments = check.judgments.map((j) => ({
      ...j,
      judgeScore: j.judgeScore === 1 ? 0 : 1,
      owner: resultScore(j),
    }));
    const text = renderReport(summarize(info(), records()), records(), check);
    expect(text).toContain(
      "The owner marked 8 of 8 judgments in spot-check.json and agrees with 8.",
    );
    expect(text).not.toContain("Disagrees on");
    // And the other way round: the file's copy says they agree, results.jsonl says they do not.
    check.judgments = check.judgments.map((j) => ({ ...j, judgeScore: 1, owner: 1 }));
    const wrong = check.judgments.filter((j) => resultScore(j) === 0);
    const again = renderReport(summarize(info(), records()), records(), check);
    expect(wrong.length).toBeGreaterThan(0);
    expect(again).toContain(`agrees with ${8 - wrong.length}.`);
    for (const j of wrong) {
      expect(again).toContain(
        `- Disagrees on ${j.questionId} (${j.agent}): the judge gave 0, the owner 1.`,
      );
    }
  });

  it("does not count a marked entry that has no judgment in results.jsonl", () => {
    const check = spotCheckSample(info(), records());
    check.judgments = check.judgments.map((j) => ({ ...j, owner: resultScore(j) }));
    const kept = records().filter((r) => !(r.kind === "judgment" && r.questionId === "q1"));
    const text = renderReport(summarize(info(), kept), kept, check);
    const orphans = check.judgments.filter((j) => j.questionId === "q1").length;
    expect(orphans).toBeGreaterThan(0);
    expect(text).toContain(`agrees with ${8 - orphans}.`);
    expect(text).toContain(`${orphans} marked entries have no judgment in results.jsonl`);
  });

  it("states a spot-check of fewer than 10 entries, or none", () => {
    const check = spotCheckSample(info(), records());
    const text = renderReport(summarize(info(), records()), records(), check);
    expect(text).toContain("Spec §9 asks for 10; this spot-check has 8.");
    check.judgments = [];
    const empty = renderReport(summarize(info(), records()), records(), check);
    expect(empty).toContain("spot-check.json holds no judgments.");
    expect(empty).not.toContain("marked none of the 0");
  });
});

describe("writeReport", () => {
  function runDir(recorded: RunRecord[]): string {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-report-"));
    openRun(dir, info());
    writeFileSync(join(dir, RESULTS_FILE), recorded.map((r) => `${JSON.stringify(r)}\n`).join(""));
    return dir;
  }

  it("writes the report, and the spot-check file once every answer is judged", () => {
    const partial = runDir(records().slice(0, -1));
    const full = runDir(records());
    try {
      expect(writeReport(partial).summary.complete).toBe(false);
      expect(existsSync(join(partial, SPOT_CHECK_FILE))).toBe(false);
      const { reportPath } = writeReport(full);
      expect(reportPath).toBe(join(full, REPORT_FILE));
      expect(readFileSync(reportPath, "utf8")).toContain("has marked none of the 8 judgments");
    } finally {
      rmSync(partial, { recursive: true, force: true });
      rmSync(full, { recursive: true, force: true });
    }
  });

  it("never writes over the owner's grades, and refuses a damaged spot-check file", () => {
    const dir = runDir(records());
    try {
      writeReport(dir);
      const path = join(dir, SPOT_CHECK_FILE);
      const check = SpotCheck.parse(JSON.parse(readFileSync(path, "utf8")));
      check.judgments = check.judgments.map((j) => ({ ...j, owner: j.judgeScore }));
      writeFileSync(path, JSON.stringify(check));
      writeReport(dir);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(check);
      expect(readFileSync(join(dir, REPORT_FILE), "utf8")).toContain(
        "The owner marked 8 of 8 judgments in spot-check.json and agrees with 8.",
      );
      writeFileSync(path, "{");
      expect(() => writeReport(dir)).toThrow(EvalRunError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
