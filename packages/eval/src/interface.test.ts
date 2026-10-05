import { describe, expect, it } from "vitest";
import { interfaceSection } from "./interface.ts";
import type { AgentKind } from "./prompts.ts";
import type { AnswerRecord, RunRecord } from "./records.ts";
import { renderReport } from "./report.ts";
import { summarize } from "./summary.ts";
import { answer, info, judgment, questions } from "./test-records.ts";

const call = (name: string): AnswerRecord["calls"][number] => ({
  turn: 1,
  name,
  input: {},
  isError: false,
});

/**
 * All four agents on the 4 test questions: wiki 3 right at 20,000 tokens, repo 4 at 80,000 with
 * 5 repository calls each, mcp 2 right at 24,000, repo+mcp 4 right at 40,000 with 2 repository
 * calls and one read_page each.
 */
function fourAgents(): RunRecord[] {
  const plan: [AgentKind, number, number, AnswerRecord["calls"]][] = [
    ["wiki", 20_000, 3, []],
    ["repo", 80_000, 4, Array.from({ length: 5 }, () => call("grep"))],
    ["mcp", 24_000, 2, [call("read_page")]],
    ["repo+mcp", 40_000, 4, [call("read_page"), call("read_file"), call("list_files")]],
  ];
  return questions.flatMap((q, i) =>
    plan.flatMap(([agent, tokens, right, calls]) => [
      answer(q.id, agent, tokens, calls),
      judgment(q.id, agent, i < right ? 1 : 0),
    ]),
  );
}

const ALL: AgentKind[] = ["wiki", "repo", "mcp", "repo+mcp"];

describe("interfaceSection", () => {
  it("states spec v2 #5 §11.4's four bars and the repository calls on a dev run", () => {
    const run = info({ set: "dev", agents: ALL });
    const lines = interfaceSection(summarize(run, fourAgents()), fourAgents());
    expect(lines.join("\n")).toBe(
      [
        "## The agent interface (spec v2 #5 §11.4)",
        "",
        "- repo+mcp accuracy: 4 of 4 against at least 4 (the repo agent's): met.",
        "- repo+mcp tokens: 40,000 per question against at most 48,000 (60% of the repo agent's 80,000): met.",
        "- Repository tool calls per question (reported, not a bar): repo+mcp 2.0, repo 5.0.",
        "- mcp accuracy: 2 of 4 against at least 2 (the wiki agent's 3 less 1): met.",
        "- mcp tokens: 24,000 per question against at most 25,000 (125% of the wiki agent's 20,000): met.",
        "",
        "Result on this set: pass.",
        "",
      ].join("\n"),
    );
  });

  it("binds only on a dev run of all four agents, and waits for every judgment", () => {
    const records = fourAgents();
    const pair = info({ set: "dev", agents: ["wiki", "mcp"] });
    expect(interfaceSection(summarize(pair, records), records).at(-2)).toBe(
      "Result: every bar met; the M8 bars bind on one dev-set run of all four agents.",
    );
    const partial = records.slice(0, -1);
    const all = info({ set: "dev", agents: ALL });
    expect(interfaceSection(summarize(all, partial), partial)).toContain(
      "Not known until every answer is judged.",
    );
    // v1's two agents get no M8 section at all.
    expect(interfaceSection(summarize(info(), records), records)).toEqual([]);
  });

  it("judges the history suite: mcp at 70% and 2 more than the wiki agent", () => {
    const records = fourAgents();
    const run = info({ set: "history", agents: ["wiki", "mcp"] });
    expect(interfaceSection(summarize(run, records), records).join("\n")).toBe(
      [
        "## History suite (spec v2 #5 §11.5)",
        "",
        "- Correct: mcp 2 of 4 against at least 3 (70%): not met.",
        "- Margin: mcp 2 against at least 5 (the wiki agent's 3 plus 2): not met.",
        "",
        "Result on this set: fail.",
        "",
      ].join("\n"),
    );
  });

  it("appears in the report with a column per asked agent", () => {
    const run = info({ set: "dev", agents: ALL });
    const text = renderReport(summarize(run, fourAgents()), fourAgents(), null);
    expect(text).toContain("4 questions, each asked to the 4 agents with");
    expect(text).toContain("## The agent interface (spec v2 #5 §11.4)");
    expect(text).toContain(
      "| Kind | Questions | Wiki correct | Repo correct | MCP correct | Repo+MCP correct |",
    );
  });
});
