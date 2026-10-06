import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAskResponse } from "@repowiki/core/test-fixtures";
import {
  type AgentKind,
  appendRecord,
  type EvalQuestion,
  openRun,
  type RunInfo,
} from "@repowiki/eval";
import { WikiView } from "@repowiki/query";
import { type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AskEvalResult, AskEvalRow } from "./ask-eval-run.ts";
import {
  baselineGate,
  criteriaLines,
  devBaseline,
  SUPPORT_SAMPLE,
  supportSheet,
  tallySupport,
} from "./ask-eval-sheet.ts";

let sample: SampleWiki;
let view: WikiView;
beforeAll(() => {
  sample = sampleWiki();
  view = new WikiView(sample.wiki);
});
afterAll(() => sample.repo.remove());

const SIGNALS = makeAskResponse().sources[0] as AskEvalRow["response"]["sources"][number];
/** A result of `n` answered questions of two sentences each, citing the sample's claim s-1. */
function result(n: number): AskEvalResult {
  const rows = Array.from(
    { length: n },
    (_, i): AskEvalRow => ({
      id: `q-${i + 1}`,
      kind: "where",
      question: `Question ${i + 1} about *signals*?`,
      response: makeAskResponse({
        sentences: [
          { text: `Sentence ${i + 1}a names \`ingest_chunk\`.`, sources: [1] },
          { text: `Sentence ${i + 1}b.`, sources: [1] },
        ],
        sources: [SIGNALS],
      }),
      ms: 2000,
      score: 1,
      judgeUsd: 0.001,
      grounded: 2,
    }),
  );
  return { rows, overBudget: [], spentUsd: 0.2 };
}
const AT = { repo: "sample", head: "a".repeat(40), startedAt: "2026-10-05T12:00:00.000Z" };
const DEV = { set: "dev" as const, head: "a".repeat(40) };
const BASELINE = {
  runDir: "/o/eval/dev-a",
  wikiCorrect: 2,
  questions: 2,
  startedAt: "2026-10-01T00:00:00.000Z",
  head: "a".repeat(40),
};

describe("supportSheet", () => {
  it("samples twenty sentences with their cited claims' full text, blind, then a routing line a question", () => {
    const { text: sheet, entries } = supportSheet(view, result(15), AT);
    const support = sheet.split("\n").filter((l) => l.startsWith("- [ ] `support/"));
    const routing = sheet.split("\n").filter((l) => l.startsWith("- [ ] `routing/"));
    expect(support).toHaveLength(SUPPORT_SAMPLE);
    expect(routing).toHaveLength(15);
    expect(entries.support).toEqual(
      Array.from(
        { length: SUPPORT_SAMPLE },
        (_, i) => `support/s${String(i + 1).padStart(2, "0")}`,
      ),
    );
    expect(entries.routing).toEqual(Array.from({ length: 15 }, (_, i) => `routing/q-${i + 1}`));
    expect(support[0]).toMatch(/^- \[ \] `support\/s01` \(sentence\): Sentence \d+[ab]/);
    expect(support[0]).toContain(
      '\u2014 cites "\\`ingest\\_chunk\\` makes one signal per non-blank sentence of a chunk and saves each one with \\`save\\_signal\\`." (Signal ingestion, Overview)',
    );
    const section = sheet.slice(0, sheet.indexOf("## Routing"));
    expect(section).not.toContain("Question 1 about");
    expect(routing[0]).toBe(
      "- [ ] `routing/q-1` (question): Question 1 about \\*signals\\*? \u2014 first source: Signal ingestion (/wiki/signals/\\#claim-s-1)",
    );
  });

  it("orders the sample by the run's start time, the same each time", () => {
    const order = (startedAt: string) =>
      supportSheet(view, result(15), { ...AT, startedAt })
        .text.split("\n")
        .filter((l) => l.startsWith("- [ ] `support/"))
        .map((l) => l.replace(/^.*\(sentence\): (\S+ \S+).*$/, "$1"));
    expect(order(AT.startedAt)).toEqual(order(AT.startedAt));
    expect(order("2027-01-01T00:00:00.000Z")).not.toEqual(order(AT.startedAt));
  });
});

describe("tallySupport", () => {
  let written: ReturnType<typeof supportSheet>;
  beforeAll(() => {
    written = supportSheet(view, result(20), AT);
  });
  const marked = (support: number, routing: number, sheet = written) => {
    let s = 0;
    let r = 0;
    return sheet.text
      .split("\n")
      .map((line) => {
        if (line.startsWith("- [ ] `support/"))
          return line.replace("[ ]", s++ < support ? "[x]" : "[!]");
        if (line.startsWith("- [ ] `routing/"))
          return line.replace("[ ]", r++ < routing ? "[x]" : "[!]");
        return line;
      })
      .join("\n");
  };

  it("counts each section apart and passes at 18 of 20 supported and 16 of 20 routed", () => {
    expect(tallySupport(marked(18, 16), written.entries)).toEqual({
      support: { lines: 20, yes: 18, no: 2, unmarked: 0, pass: true },
      routing: { lines: 20, yes: 16, no: 4, unmarked: 0, pass: true },
    });
    const short = tallySupport(marked(17, 15), written.entries);
    expect([short.support.pass, short.routing.pass]).toEqual([false, false]);
    const blank = tallySupport(written.text, written.entries);
    expect(blank.support).toEqual({ lines: 20, yes: 0, no: 0, unmarked: 20, pass: false });
  });

  it("refuses a mark it cannot read and a file that is not a support sheet", () => {
    expect(() =>
      tallySupport(
        marked(18, 16).replace("- [x] `support/s01`", "- [?] `support/s01`"),
        written.entries,
      ),
    ).toThrow(/mark a claim/);
    expect(() => tallySupport("# notes\n- [x] `a/b` (x)\n", written.entries)).toThrow(
      /no "## Routing" section/,
    );
  });

  it("measures each section against the entries the sheet was written with", () => {
    const small = supportSheet(view, result(3), AT);
    expect(small.entries.support).toHaveLength(6);
    const counted = tallySupport(marked(6, 2, small), small.entries);
    expect(counted.support).toEqual({ lines: 6, yes: 6, no: 0, unmarked: 0, pass: true });
    expect(counted.routing).toEqual({ lines: 3, yes: 2, no: 1, unmarked: 0, pass: false });
  });

  it("refuses a sheet with an entry removed or added, naming the counts, on one line", () => {
    const lines = marked(20, 20).split("\n");
    const without = lines.filter((l) => !l.includes("`support/s07`")).join("\n");
    expect(() => tallySupport(without, written.entries)).toThrow(
      /^the Support section has 19 entries, but the sheet was written with 20 \(missing support\/s07\)$/,
    );
    const extra = [...lines, "- [x] `routing/q-99` (question): Q? \u2014 first source: P"].join(
      "\n",
    );
    expect(() => tallySupport(extra, written.entries)).toThrow(
      /^the Routing section has 21 entries, but the sheet was written with 20 \(not written: routing\/q-99\)$/,
    );
  });
});

describe("devBaseline and criteriaLines", () => {
  const QUESTIONS: EvalQuestion[] = Array.from({ length: 2 }, (_, i) => ({
    id: `q-${i + 1}`,
    set: "dev",
    kind: "where",
    question: `Placeholder question ${i + 1}?`,
    reference: "Placeholder reference.",
  }));
  const info = (startedAt: string, questionsHash = "f".repeat(64)): RunInfo => ({
    set: "dev",
    repo: "sample",
    head: "a".repeat(40),
    exportHash: "e".repeat(64),
    questionsHash,
    writtenOn: "2026-10-01",
    turnLimit: 15,
    agents: ["wiki", "repo"],
    models: { evalAgent: "claude-haiku-4-5", evalJudge: "claude-haiku-4-5" },
    buildTokens: null,
    questions: QUESTIONS,
    startedAt,
  });
  /** A dev run directory: every question answered by both agents, the wiki agent right `wiki` times. */
  function devRun(out: string, name: string, run: RunInfo, wiki: number, judged = true) {
    const dir = join(out, "eval", name);
    openRun(dir, run);
    run.questions.forEach((q, i) => {
      for (const agent of ["wiki", "repo"] as AgentKind[]) {
        appendRecord(dir, {
          kind: "answer",
          questionId: q.id,
          agent,
          answer: "a",
          stop: "answered",
          turns: 2,
          calls: [],
          usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
          usd: 0.01,
          model: "claude-haiku-4-5",
          at: run.startedAt,
        });
        if (!judged) continue;
        appendRecord(dir, {
          kind: "judgment",
          questionId: q.id,
          agent,
          score: agent === "wiki" && i >= wiki ? 0 : 1,
          verdict: null,
          reason: "r",
          usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
          usd: 0.001,
          model: "claude-haiku-4-5",
          batch: true,
          at: run.startedAt,
        });
      }
    });
    return dir;
  }

  it("takes the latest complete dev run of the wiki agent on the same question file", () => {
    const out = mkdtempSync(join(tmpdir(), "repowiki-ask-baseline-"));
    try {
      expect(devBaseline(out, "f".repeat(64))).toBeNull();
      devRun(out, "dev-a", info("2026-10-01T00:00:00.000Z"), 1);
      const latest = devRun(out, "dev-b", info("2026-10-02T00:00:00.000Z"), 2);
      devRun(out, "dev-c", info("2026-10-03T00:00:00.000Z"), 0, false);
      devRun(out, "dev-d", info("2026-10-04T00:00:00.000Z", "0".repeat(64)), 0);
      const baseline = devBaseline(out, "f".repeat(64));
      expect(baseline).toEqual({
        runDir: latest,
        wikiCorrect: 2,
        questions: 2,
        startedAt: "2026-10-02T00:00:00.000Z",
        head: "a".repeat(40),
      });
      const two = result(2);
      expect(criteriaLines(two, baseline, DEV).join("\n")).toContain(
        "the ask got 2 of 2 and the wiki agent 2 of 2 in",
      );
      expect(
        criteriaLines(
          { ...two, rows: two.rows.map((r) => ({ ...r, score: 0 })) },
          baseline,
          DEV,
        ).join("\n"),
      ).toContain(": not met (at least 90% of the wiki agent's).");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("takes the latest by its start time, not by its name or its text", () => {
    const out = mkdtempSync(join(tmpdir(), "repowiki-ask-baseline-"));
    try {
      // dev-z started first; dev-a's offset makes it the latest though its text sorts first.
      devRun(out, "dev-z", info("2026-10-02T09:00:00.000Z"), 1);
      const latest = devRun(out, "dev-a", info("2026-10-02T08:30:00.000-02:00"), 2);
      devRun(out, "dev-m", info("2026-10-02T08:00:00.000Z"), 0);
      expect(devBaseline(out, "f".repeat(64))?.runDir).toBe(latest);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("does not call the bar met against a wiki agent that got none right", () => {
    const zero = { runDir: "/x/eval/dev-a", wikiCorrect: 0, questions: 2 };
    const two = result(2);
    const none = { ...two, rows: two.rows.map((r) => ({ ...r, score: 0 as const })) };
    const line = criteriaLines(none, { ...BASELINE, ...zero }, DEV).join("\n");
    expect(line).not.toContain(": met");
    expect(line).toContain("cannot be scored: the wiki agent got none right");
  });

  it("says when there is nothing to compare against", () => {
    expect(criteriaLines(result(2), null, DEV).join("\n")).toContain("cannot be scored yet");
  });

  it("finds a dev run by its run.json, whatever its folder is called, and says which it skipped", () => {
    const out = mkdtempSync(join(tmpdir(), "repowiki-ask-baseline-"));
    try {
      const named = devRun(out, "my-baseline", info("2026-10-02T00:00:00.000Z"), 2);
      devRun(out, "dev-held", { ...info("2026-10-03T00:00:00.000Z"), set: "held-out" }, 2);
      devRun(out, "dev-repo", { ...info("2026-10-04T00:00:00.000Z"), agents: ["repo"] }, 2);
      mkdirSync(join(out, "eval", "ask-2026-10-05"));
      writeFileSync(join(out, "eval", "ask-2026-10-05", "results.json"), "{}");
      writeFileSync(join(out, "eval", "notes.txt"), "not a run");
      mkdirSync(join(out, "eval", "dev-broken"));
      writeFileSync(join(out, "eval", "dev-broken", "run.json"), "{");
      const skipped: string[] = [];
      expect(devBaseline(out, "f".repeat(64), (line) => skipped.push(line))?.runDir).toBe(named);
      expect(skipped).toEqual([
        `skipped ${join(out, "eval", "dev-broken")}: cannot read ${join(out, "eval", "dev-broken", "run.json")}`,
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("calls the bar met at 90% of the wiki agent's, and not below", () => {
    const twenty = result(20);
    const graded = (correct: number) => ({
      ...twenty,
      rows: twenty.rows.map((r, i) => ({ ...r, score: i < correct ? (1 as const) : null })),
    });
    const full = { ...BASELINE, wikiCorrect: 20, questions: 20 };
    expect(criteriaLines(graded(18), full, DEV).join("\n")).toContain(
      "the ask got 18 of 20 and the wiki agent 20 of 20",
    );
    expect(criteriaLines(graded(18), full, DEV).join("\n")).toContain(": met (at least 90%");
    expect(criteriaLines(graded(17), full, DEV).join("\n")).toContain(": not met (at least 90%");
    expect(criteriaLines(graded(20), { ...full, questions: 19 }, DEV).join("\n")).toContain(
      "asked 19 questions and this one 20, so they cannot be compared",
    );
  });

  it("says when the run compared against asked another commit of the wiki", () => {
    const line = criteriaLines(result(2), BASELINE, { set: "dev", head: "b".repeat(40) }).join(
      "\n",
    );
    expect(line).toContain("That run asked the wiki at aaaaaaa; this one at bbbbbbb.");
    expect(criteriaLines(result(2), BASELINE, DEV).join("\n")).not.toContain("That run asked");
  });

  it("compares nothing on the smoke set", () => {
    const line = criteriaLines(result(2), null, { set: "smoke", head: "a".repeat(40) }).join("\n");
    expect(line).toContain(
      "- Accuracy against the wiki agent: not compared: the smoke set scores nothing.",
    );
  });
});

describe("baselineGate", () => {
  const WHY =
    "no complete `eval:run --set dev` run on this question file is in /o/eval; run `pnpm eval:run <repo> --questions <file> --set dev` first, or pass --no-baseline";
  const gate = (over: Partial<Parameters<typeof baselineGate>[0]>) =>
    baselineGate({
      set: "dev",
      required: true,
      dryRun: false,
      baseline: null,
      evalDir: "/o/eval",
      ...over,
    });

  it("names the dev run it compares with", () => {
    expect(gate({ baseline: BASELINE })).toEqual({
      line: `comparing with ${BASELINE.runDir} (started ${BASELINE.startedAt}, the wiki at aaaaaaa)`,
      stop: false,
      exitCode: 0,
    });
  });

  it("stops a run with none in one line, exit 1, before any call", () => {
    expect(gate({})).toEqual({ line: WHY, stop: true, exitCode: 1 });
  });

  it("lets a dry run with none show its estimate and say the run would stop, exit 0", () => {
    expect(gate({ dryRun: true })).toEqual({
      line: `no baseline yet: the run would stop; ${WHY}`,
      stop: true,
      exitCode: 0,
    });
  });

  it("goes on with none under --no-baseline, and never needs one for the smoke set", () => {
    expect(gate({ required: false })).toEqual({ line: null, stop: false, exitCode: 0 });
    expect(gate({ set: "smoke" })).toEqual({ line: null, stop: false, exitCode: 0 });
    expect(gate({ set: "smoke", dryRun: true })).toEqual({ line: null, stop: false, exitCode: 0 });
  });
});
