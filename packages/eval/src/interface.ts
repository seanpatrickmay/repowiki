import type { AgentKind } from "./prompts.ts";
import type { RunRecord } from "./records.ts";
import { type EvalSummary, latestRecords, tokensOf } from "./summary.ts";

/** Spec v2 #5 §11.4: repo+mcp accuracy at least the repo agent's, and its tokens at most 60%. */
export const REPO_MCP_TOKEN_PERCENT = 60;
/** §11.4: mcp accuracy at least the wiki agent's less one question… */
export const MCP_ACCURACY_SLACK = 1;
/** …and its tokens at most 125% of the wiki agent's. */
export const MCP_TOKEN_PERCENT = 125;
/** §11.5: on the history suite mcp answers at least 7 in 10… */
export const HISTORY_CORRECT_PERCENT = 70;
/** …and at least 2 more than the v1 wiki agent. */
export const HISTORY_MARGIN = 2;
/** The repo agent's tools, counted per question for repo and repo+mcp (§11.4, reported only). */
export const REPO_TOOL_NAMES: readonly string[] = ["list_files", "read_file", "grep"];

const count = (n: number) => Math.round(n).toLocaleString("en-US");
const met = (ok: boolean) => (ok ? "met" : "not met");

/**
 * The report's M8 section (spec v2 #5 §11.4-5), for the agents the run asked: on the history set,
 * mcp against the wiki agent; on any other set, repo+mcp against repo and mcp against wiki, with
 * the repository tool calls per question. Empty when the run asked none of these pairs.
 */
export function interfaceSection(summary: EvalSummary, records: readonly RunRecord[]): string[] {
  const { info, agents, complete } = summary;
  const asked = (a: AgentKind) => info.agents.includes(a);
  const n = info.questions.length;
  const { answers } = latestRecords(records);
  const answered = (agent: AgentKind) =>
    info.questions.flatMap((q) => answers.get(`${q.id}\0${agent}`) ?? []);
  const total = (agent: AgentKind) => answered(agent).reduce((s, a) => s + tokensOf(a.usage), 0);
  const history = info.set === "history";
  const pairs = history
    ? asked("mcp") && asked("wiki")
    : (asked("repo+mcp") && asked("repo")) || (asked("mcp") && asked("wiki"));
  if (!pairs) return [];
  const lines = [
    history
      ? "## History suite (spec v2 #5 \u00A711.5)"
      : "## The agent interface (spec v2 #5 \u00A711.4)",
    "",
  ];
  if (!complete) return [...lines, "Not known until every answer is judged.", ""];
  if (history) {
    const { mcp, wiki } = agents;
    const share = 100 * mcp.correct >= HISTORY_CORRECT_PERCENT * n;
    const margin = mcp.correct >= wiki.correct + HISTORY_MARGIN;
    return [
      ...lines,
      `- Correct: mcp ${mcp.correct} of ${n} against at least ${Math.ceil((HISTORY_CORRECT_PERCENT * n) / 100)} (${HISTORY_CORRECT_PERCENT}%): ${met(share)}.`,
      `- Margin: mcp ${mcp.correct} against at least ${wiki.correct + HISTORY_MARGIN} (the wiki agent's ${wiki.correct} plus ${HISTORY_MARGIN}): ${met(margin)}.`,
      "",
      `Result on this set: ${share && margin ? "pass" : "fail"}.`,
      "",
    ];
  }
  const results: boolean[] = [];
  if (asked("repo+mcp") && asked("repo")) {
    const both = agents["repo+mcp"];
    const accuracy = both.correct >= agents.repo.correct;
    const tokens = 100 * total("repo+mcp") <= REPO_MCP_TOKEN_PERCENT * total("repo");
    results.push(accuracy, tokens);
    const calls = (agent: AgentKind) =>
      answered(agent).reduce(
        (s, a) => s + a.calls.filter((c) => REPO_TOOL_NAMES.includes(c.name)).length,
        0,
      ) / n;
    lines.push(
      `- repo+mcp accuracy: ${both.correct} of ${n} against at least ${agents.repo.correct} (the repo agent's): ${met(accuracy)}.`,
      `- repo+mcp tokens: ${count(total("repo+mcp") / n)} per question against at most ${count((REPO_MCP_TOKEN_PERCENT * total("repo")) / 100 / n)} (${REPO_MCP_TOKEN_PERCENT}% of the repo agent's ${count(total("repo") / n)}): ${met(tokens)}.`,
      `- Repository tool calls per question (reported, not a bar): repo+mcp ${calls("repo+mcp").toFixed(1)}, repo ${calls("repo").toFixed(1)}.`,
    );
  }
  if (asked("mcp") && asked("wiki")) {
    const { mcp, wiki } = agents;
    const floor = Math.max(0, wiki.correct - MCP_ACCURACY_SLACK);
    const accuracy = mcp.correct >= floor;
    const tokens = 100 * total("mcp") <= MCP_TOKEN_PERCENT * total("wiki");
    results.push(accuracy, tokens);
    lines.push(
      `- mcp accuracy: ${mcp.correct} of ${n} against at least ${floor} (the wiki agent's ${wiki.correct} less ${MCP_ACCURACY_SLACK}): ${met(accuracy)}.`,
      `- mcp tokens: ${count(total("mcp") / n)} per question against at most ${count((MCP_TOKEN_PERCENT * total("wiki")) / 100 / n)} (${MCP_TOKEN_PERCENT}% of the wiki agent's ${count(total("wiki") / n)}): ${met(tokens)}.`,
    );
  }
  const binds = info.set === "dev" && results.length === 4;
  return [
    ...lines,
    "",
    binds
      ? `Result on this set: ${results.every(Boolean) ? "pass" : "fail"}.`
      : `Result: ${results.every(Boolean) ? "every bar met" : "not every bar met"}; the M8 bars bind on one dev-set run of all four agents.`,
    "",
  ];
}
