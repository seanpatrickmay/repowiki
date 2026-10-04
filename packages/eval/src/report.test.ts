import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS, EvalRunError, openRun, RESULTS_FILE, type RunRecord } from "./records.ts";
import { REPORT_FILE, renderReport, writeReport } from "./report.ts";
import { SPOT_CHECK_FILE, SpotCheck, spotCheckEntry, spotCheckSample } from "./spot-check.ts";
import { summarize } from "./summary.ts";
import { AT, info, records } from "./test-records.ts";

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

  it("states the break-even only for a complete run, and what its numerator leaves out", () => {
    const full = renderReport(summarize(info(), records()), records(), null);
    expect(full).toContain(
      "(1,000,000 / 60,000). The build's tokens are its build run's in export.json; manifest tokens are not included.",
    );
    const partial = renderReport(
      summarize(info(), records().slice(0, -1)),
      records().slice(0, -1),
      null,
    );
    expect(partial).toContain("## Break-even\n\nNot known until every answer is judged.");
    const old = renderReport(summarize(info({ buildTokens: null }), records()), records(), null);
    expect(old).toContain(
      "Unknown: the export this run read records no build run. Re-run pnpm wiki:export to include build tokens before the next run.",
    );
  });

  it("states no pass test when the repo agent answered nothing correctly", () => {
    const zero = records().map((r) => (r.kind === "judgment" ? { ...r, score: 0 as const } : r));
    const text = renderReport(summarize(info(), zero), zero, null);
    expect(text).toContain(
      "## Pass test (spec \u00A79)\n\nNot meaningful on this run: the repo agent answered no question correctly, so 90% of its accuracy is 0 and any wiki accuracy would meet it.",
    );
    expect(text).not.toContain("Result on this set");
  });

  it("counts what failed judgments cost, and says when a cost is unknown", () => {
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
    const withFailure = [...records(), failed];
    expect(renderReport(summarize(info(), withFailure), withFailure, null)).toContain(
      "Agents $0.4000, judge $0.0050 (failed judgments included): $0.4050 in all",
    );
    const unknown = records().map((r, i) => (i === 0 ? { ...r, usd: null } : r));
    expect(renderReport(summarize(info(), unknown), unknown, null)).toContain(
      "Agents unknown, judge $0.0040: unknown in all: a call's model has no price.",
    );
  });
  it("is counted in the report once the owner marks it", () => {
    const check = spotCheckSample(info(), records());
    const first = check.answers[0] as (typeof check.answers)[0];
    const second = check.answers[1] as (typeof check.answers)[0];
    const judged = judgedAs(second);
    check.answers[0] = { ...first, owner: 1 };
    check.answers[1] = { ...second, owner: judged.score === 1 ? 0 : 1 };
    const text = renderReport(summarize(info(), records()), records(), check);
    expect(text).toContain("The owner marked 2 of 8 judgments in spot-check.json and agrees with");
    expect(text).toContain(
      `- Disagrees on ${second.questionId} (${judged.agent}): the judge gave ${judged.score}, the owner ${judged.score === 1 ? 0 : 1}. The judge's reason: `,
    );
  });
});

/** The judgment and agent behind a spot-check entry, from results.jsonl. */
function judgedAs(entry: { entry: string; questionId: string }, recorded = records()) {
  for (const agent of AGENTS) {
    if (spotCheckEntry(info().startedAt, entry.questionId, agent) !== entry.entry) continue;
    const found = recorded.find(
      (r) => r.kind === "judgment" && r.questionId === entry.questionId && r.agent === agent,
    );
    return { agent, score: found?.kind === "judgment" ? found.score : null };
  }
  throw new Error(`no agent for ${entry.entry}`);
}

describe("text from a model or the author in the report", () => {
  it("is one line of plain text: no markdown, no HTML and no invisible characters", () => {
    const hostile =
      "See [x](https://e.example) ![p](https://e.example/p.png) <img src=x> `code` **b** _i_ ~~s~~ #h a\\b | c\u200B\u00AD\u{E0041}\u2060 end";
    const recorded = records().map((r) =>
      r.kind === "judgment" && r.questionId === "q1" && r.agent === "wiki"
        ? { ...r, reason: hostile }
        : r,
    );
    const text = renderReport(
      summarize(info({ repo: "[evil](https://e.example)" }), recorded),
      recorded,
      null,
    );
    expect(text).toContain(
      "  - wiki (1): See \\[x\\]\\(https://e.example\\) \\!\\[p\\]\\(https://e.example/p.png\\) \\<img src=x\\> \\`code\\` \\*\\*b\\*\\* \\_i\\_ \\~\\~s\\~\\~ \\#h a\\\\b \\| c end",
    );
    expect(text.split("\n")[0]).toBe("# Eval: \\[evil\\]\\(https://e.example\\), held-out set");
    expect(text).not.toMatch(/[\u200B\u00AD\u2060]|\u{E0041}/u);
  });
});

describe("the owner's agreement with the judge", () => {
  it("joins each entry to its judgment in results.jsonl and names the agent only there", () => {
    const check = spotCheckSample(info(), records());
    check.answers = check.answers.map((a) => ({ ...a, owner: judgedAs(a).score }));
    const text = renderReport(summarize(info(), records()), records(), check);
    expect(text).toContain(
      "The owner marked 8 of 8 judgments in spot-check.json and agrees with 8.",
    );
    expect(text).not.toContain("Disagrees on");
    check.answers = check.answers.map((a) => ({ ...a, owner: 1 }));
    const wrong = check.answers.filter((a) => judgedAs(a).score === 0);
    const again = renderReport(summarize(info(), records()), records(), check);
    expect(wrong.length).toBeGreaterThan(0);
    expect(again).toContain(`agrees with ${8 - wrong.length}.`);
    for (const a of wrong) {
      expect(again).toContain(
        `- Disagrees on ${a.questionId} (${judgedAs(a).agent}): the judge gave 0, the owner 1. The judge's reason: Names \\| another file.`,
      );
    }
  });

  it("shows the judge's reason where they disagree as text the owner can see", () => {
    const hostile = records().map((r) =>
      r.kind === "judgment" && r.score === 0
        ? { ...r, reason: "Wrong\u202E file\u200B, see [x](https://e.example)\n# heading" }
        : r,
    );
    const check = spotCheckSample(info(), hostile);
    check.answers = check.answers.map((a) => ({ ...a, owner: 1 }));
    const text = renderReport(summarize(info(), hostile), hostile, check);
    const line = text.split("\n").find((l) => l.startsWith("- Disagrees on")) ?? "";
    expect(line).toContain("The judge's reason: Wrong file, see ");
    expect(line).not.toMatch(/[\u200B\u202E]/);
    expect(line).toContain("see \\[x\\]\\(https://e.example\\) \\# heading");
  });

  it("does not count a marked entry that has no judgment in results.jsonl", () => {
    const check = spotCheckSample(info(), records());
    check.answers = check.answers.map((a) => ({ ...a, owner: judgedAs(a).score }));
    const kept = records().filter((r) => !(r.kind === "judgment" && r.questionId === "q1"));
    const text = renderReport(summarize(info(), kept), kept, check);
    const orphans = check.answers.filter((a) => a.questionId === "q1").length;
    expect(orphans).toBeGreaterThan(0);
    expect(text).toContain(`agrees with ${8 - orphans}.`);
    expect(text).toContain(`${orphans} marked entries have no judgment in results.jsonl`);
  });

  it("states a spot-check of fewer than 10 entries, or none", () => {
    const check = spotCheckSample(info(), records());
    const text = renderReport(summarize(info(), records()), records(), check);
    expect(text).toContain("Spec \u00A79 asks for 10; this spot-check has 8.");
    check.answers = [];
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

  it("writes past a temporary file a killed run left behind", () => {
    const dir = runDir(records());
    try {
      writeFileSync(join(dir, `${SPOT_CHECK_FILE}.${process.pid}.tmp`), "{");
      writeFileSync(join(dir, `${REPORT_FILE}.${process.pid}.tmp`), "half");
      writeReport(dir);
      expect(
        SpotCheck.parse(JSON.parse(readFileSync(join(dir, SPOT_CHECK_FILE), "utf8"))).answers,
      ).toHaveLength(8);
      expect(readFileSync(join(dir, REPORT_FILE), "utf8")).toContain("# Eval:");
      expect(existsSync(join(dir, `${SPOT_CHECK_FILE}.${process.pid}.tmp`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      check.answers = check.answers.map((a) => ({ ...a, owner: judgedAs(a).score }));
      writeFileSync(path, JSON.stringify(check));
      writeReport(dir);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(check);
      expect(readFileSync(join(dir, REPORT_FILE), "utf8")).toContain(
        "The owner marked 8 of 8 judgments in spot-check.json and agrees with 8.",
      );
      writeFileSync(path, JSON.stringify({ ...check, run: { ...check.run, startedAt: AT } }));
      expect(() => writeReport(dir)).toThrow(
        `${path} is from another run (begun ${AT}), not this one (begun ${info().startedAt}); move it aside to draw a new sample`,
      );
      writeFileSync(path, "{");
      expect(() => writeReport(dir)).toThrow(EvalRunError);
      writeFileSync(
        path,
        JSON.stringify({ ...check, answers: [{ ...check.answers[0], owner: "1" }] }),
      );
      expect(() => writeReport(dir)).toThrow(
        `${path} is not a valid spot-check file: answers.0.owner: Invalid input; set "owner" to the number 0 or 1, or move the file aside to draw a new sample`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
