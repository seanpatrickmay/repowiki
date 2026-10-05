import { makeAskResponse } from "@repowiki/core/test-fixtures";
import { WikiView } from "@repowiki/query";
import { type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AskEvalResult, AskEvalRow } from "./ask-eval-run.ts";
import { SUPPORT_SAMPLE, supportSheet, tallySupport } from "./ask-eval-sheet.ts";

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
    }),
  );
  return { rows, overBudget: [], spentUsd: 0.2 };
}
const AT = { repo: "sample", head: "a".repeat(40), startedAt: "2026-10-05T12:00:00.000Z" };

describe("supportSheet", () => {
  it("samples twenty sentences with their cited claims' full text, blind, then a routing line a question", () => {
    const sheet = supportSheet(view, result(15), AT);
    const support = sheet.split("\n").filter((l) => l.startsWith("- [ ] `support/"));
    const routing = sheet.split("\n").filter((l) => l.startsWith("- [ ] `routing/"));
    expect(support).toHaveLength(SUPPORT_SAMPLE);
    expect(routing).toHaveLength(15);
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
        .split("\n")
        .filter((l) => l.startsWith("- [ ] `support/"))
        .map((l) => l.replace(/^.*\(sentence\): (\S+ \S+).*$/, "$1"));
    expect(order(AT.startedAt)).toEqual(order(AT.startedAt));
    expect(order("2027-01-01T00:00:00.000Z")).not.toEqual(order(AT.startedAt));
  });
});

describe("tallySupport", () => {
  const marked = (support: number, routing: number) => {
    let s = 0;
    let r = 0;
    return supportSheet(view, result(20), AT)
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
    expect(tallySupport(marked(18, 16))).toEqual({
      support: { lines: 20, yes: 18, no: 2, unmarked: 0, pass: true },
      routing: { lines: 20, yes: 16, no: 4, unmarked: 0, pass: true },
    });
    const short = tallySupport(marked(17, 15));
    expect([short.support.pass, short.routing.pass]).toEqual([false, false]);
    const blank = tallySupport(supportSheet(view, result(20), AT));
    expect(blank.support).toEqual({ lines: 20, yes: 0, no: 0, unmarked: 20, pass: false });
  });

  it("refuses a mark it cannot read and a file that is not a support sheet", () => {
    expect(() =>
      tallySupport(marked(18, 16).replace("- [x] `support/s01`", "- [?] `support/s01`")),
    ).toThrow(/mark a claim/);
    expect(() => tallySupport("# notes\n- [x] `a/b` (x)\n")).toThrow(/no "## Routing" section/);
  });
});
