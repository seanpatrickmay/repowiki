import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markdownText, oneLine } from "@repowiki/query";
import { interfaceSection } from "./interface.ts";
import { visibleText } from "./judge.ts";
import type { AgentKind } from "./prompts.ts";
import { QuestionKind } from "./questions.ts";
import {
  checkRecords,
  createOnce,
  EvalRunError,
  type RunRecord,
  readRecords,
  readRunInfo,
} from "./records.ts";
import {
  SPOT_CHECK_FILE,
  SPOT_CHECK_SIZE,
  SpotCheck,
  spotCheckEntry,
  spotCheckSample,
} from "./spot-check.ts";
import {
  ACCURACY_PERCENT,
  ACCURACY_SHARE,
  type EvalSummary,
  latestRecords,
  summarize,
  TOKEN_PERCENT,
  TOKEN_SHARE,
  tokensOf,
} from "./summary.ts";

const count = (n: number) => Math.round(n).toLocaleString("en-US");
const percent = (x: number) => `${Math.round(x * 1000) / 10}%`;
const usd = (x: number) => `$${x.toFixed(4)}`;
/** Model or author text in the report: one line of plain text, cut short (markdownText). */
const cell = (text: string, max = 120) => markdownText(text, max);
const KINDS: readonly QuestionKind[] = QuestionKind.options;
/** Each agent's name in a table heading. */
const LABELS: Readonly<Record<AgentKind, string>> = {
  wiki: "Wiki",
  repo: "Repo",
  mcp: "MCP",
  "repo+mcp": "Repo+MCP",
};

/** The run's report for the owner (spec §9): accuracy, tokens, the pass test and the break-even point. */
export function renderReport(
  summary: EvalSummary,
  records: readonly RunRecord[],
  spotCheck: SpotCheck | null,
): string {
  const { info, agents, complete } = summary;
  const { answers, judgments } = latestRecords(records);
  const n = info.questions.length;
  const lines = [
    `# Eval: ${cell(info.repo, 80)}, ${info.set} set`,
    "",
    `${n} questions, each asked to ${info.agents.length === 2 ? "both agents" : info.agents.length === 1 ? `the ${info.agents[0]} agent` : `the ${info.agents.length} agents`} with ${cell(info.models.evalAgent, 60)} and a limit of ${info.turnLimit} turns, and judged by ${cell(info.models.evalJudge, 60)}. The wiki is the export at commit ${info.head.slice(0, 7)}${info.agents.some((a) => a === "repo" || a === "repo+mcp") ? "; the repo agent read the repository at the same commit" : ""}.${info.writtenOn === null ? "" : ` The author wrote the questions on ${info.writtenOn}, by his statement.`} The run began ${info.startedAt}.`,
    "",
  ];
  if (info.set === "smoke") {
    lines.push(
      "This is the smoke set: questions about the test fixture that check the harness. It measures nothing.",
      "",
    );
  } else if (info.set === "history") {
    lines.push(
      "This is the history suite: questions about the wiki's past (spec v2 #5 \u00A78.1). Spec \u00A79's pass test does not apply to it.",
      "",
    );
  } else if (info.set === "dev") {
    lines.push(
      "This is the dev set: its figures track progress. Spec \u00A79's pass test binds only on the held-out set.",
      "",
    );
  }
  if (!complete) {
    const missing = info.agents.reduce((s, a) => s + n - agents[a].answered, 0);
    const unjudged = info.agents.reduce((s, a) => s + agents[a].answered - agents[a].judged, 0);
    lines.push(
      `Incomplete: ${missing} answers and ${unjudged} judgments missing. Run pnpm eval:run again with the same run directory to finish; no question is asked twice.`,
      "",
    );
  }
  lines.push(
    "| Agent | Correct | Accuracy | Tokens per question | Cost per question | Answered on the last turn |",
    "|---|---:|---:|---:|---:|---:|",
    ...info.agents.map((a) => {
      const s = agents[a];
      return `| ${a} | ${s.correct} of ${n} | ${s.accuracy === null ? "-" : percent(s.accuracy)} | ${s.tokensPerQuestion === null ? "-" : count(s.tokensPerQuestion)} | ${s.usdPerQuestion === null ? "-" : usd(s.usdPerQuestion)} | ${s.lastTurn} |`;
    }),
    "",
  );
  lines.push(...interfaceSection(summary, records));
  const v1 = info.agents.includes("wiki") && info.agents.includes("repo");
  if (complete && v1 && agents.repo.correct === 0) {
    lines.push(
      "## Pass test (spec \u00A79)",
      "",
      `Not meaningful on this run: the repo agent answered no question correctly, so ${ACCURACY_PERCENT}% of its accuracy is 0 and any wiki accuracy would meet it.`,
      "",
    );
  } else if (summary.pass !== null) {
    const { wiki, repo } = agents;
    const wAcc = wiki.accuracy ?? 0;
    const rAcc = repo.accuracy ?? 0;
    const wTok = wiki.tokensPerQuestion ?? 0;
    const rTok = repo.tokensPerQuestion ?? 0;
    lines.push(
      "## Pass test (spec \u00A79)",
      "",
      `- Accuracy: the wiki agent's ${percent(wAcc)} against at least ${percent(ACCURACY_SHARE * rAcc)} (${ACCURACY_PERCENT}% of the repo agent's ${percent(rAcc)}): ${summary.pass.accuracy ? "met" : "not met"}.`,
      `- Tokens: the wiki agent's ${count(wTok)} per question against at most ${count(TOKEN_SHARE * rTok)} (${TOKEN_PERCENT}% of the repo agent's ${count(rTok)}): ${summary.pass.tokens ? "met" : "not met"}.`,
      "",
      `Result on this set: ${summary.pass.accuracy && summary.pass.tokens ? "pass" : "fail"}.`,
      "",
    );
  }
  lines.push("## Break-even", "");
  if (!v1) {
    lines.push(
      "Not stated: the break-even compares the wiki and repo agents, and this run did not ask both.",
      "",
    );
  } else if (info.buildTokens === null) {
    lines.push(
      "Unknown: the export this run read records no build run. Re-run pnpm wiki:export to include build tokens before the next run.",
      "",
    );
  } else if (!complete) {
    lines.push("Not known until every answer is judged.", "");
  } else if (summary.breakEven === "never") {
    lines.push(
      `Never: the wiki agent used no fewer tokens per question than the repo agent, so the build's ${count(info.buildTokens)} tokens are never paid back.`,
      "",
    );
  } else if (summary.breakEven !== null) {
    const saved = (agents.repo.tokensPerQuestion ?? 0) - (agents.wiki.tokensPerQuestion ?? 0);
    lines.push(
      `The build cost ${count(info.buildTokens)} tokens. Each question answered from the wiki instead of the code saves ${count(saved)} tokens, so the build pays for itself after ${Math.ceil(summary.breakEven).toLocaleString("en-US")} questions (${count(info.buildTokens)} / ${count(saved)}). The build's tokens are its build run's in export.json; manifest tokens are not included.`,
      "",
    );
  }
  lines.push(
    "## By kind",
    "",
    `| Kind | Questions | ${info.agents.map((a) => `${LABELS[a]} correct`).join(" | ")} |`,
    `|---|---:|${info.agents.map(() => "---:").join("|")}|`,
  );
  for (const kind of KINDS) {
    const of = info.questions.filter((q) => q.kind === kind);
    if (of.length === 0) continue;
    const right = (a: AgentKind) =>
      of.filter((q) => judgments.get(`${q.id}\0${a}`)?.score === 1).length;
    lines.push(`| ${kind} | ${of.length} | ${info.agents.map(right).join(" | ")} |`);
  }
  lines.push(
    "",
    "## Questions",
    "",
    `| Question | Kind | ${[...info.agents.map((a) => LABELS[a]), ...info.agents.map((a) => `${LABELS[a]} tokens`), ...info.agents.map((a) => `${LABELS[a]} turns`)].join(" | ")} |`,
    `|---|---|${info.agents.flatMap(() => ["---:", "---:", "---:"]).join("|")}|`,
  );
  for (const q of info.questions) {
    const at = (a: AgentKind) => ({
      a: answers.get(`${q.id}\0${a}`),
      j: judgments.get(`${q.id}\0${a}`),
    });
    const rows = info.agents.map(at);
    const score = (x: (typeof rows)[number]) => (x.j === undefined ? "-" : String(x.j.score));
    const tokens = (x: (typeof rows)[number]) =>
      x.a === undefined ? "-" : count(tokensOf(x.a.usage));
    const turns = (x: (typeof rows)[number]) => (x.a === undefined ? "-" : String(x.a.turns));
    lines.push(
      `| ${cell(q.id)} | ${q.kind} | ${[...rows.map(score), ...rows.map(tokens), ...rows.map(turns)].join(" | ")} |`,
    );
  }
  lines.push("", "## The judge's reasons", "");
  for (const q of info.questions) {
    lines.push(`- ${cell(q.id)}: ${cell(q.question, 200)}`);
    for (const a of info.agents) {
      const j = judgments.get(`${q.id}\0${a}`);
      if (j !== undefined) lines.push(`  - ${a} (${j.score}): ${cell(j.reason, 500)}`);
    }
  }
  lines.push("", "## Spot-check", "");
  if (spotCheck === null) {
    lines.push(
      "Not written yet: pnpm eval:run writes spot-check.json once every answer is judged.",
      "",
    );
  } else {
    // The file is blind: each entry's key is joined back to its agent and judgment here.
    const byEntry = new Map(
      [...judgments.values()].map((j) => [
        spotCheckEntry(info.startedAt, j.questionId, j.agent),
        j,
      ]),
    );
    const entries = spotCheck.answers.map((a) => {
      const j = byEntry.get(a.entry);
      return {
        ...a,
        agent: j?.agent,
        judge: j?.score ?? null,
        reason: j === undefined ? "" : visibleText(j.reason),
      };
    });
    const marked = entries.filter((j) => j.owner !== null);
    const compared = marked.filter((j) => j.judge !== null);
    const unmatched = marked.length - compared.length;
    const agree = compared.filter((j) => j.owner === j.judge).length;
    lines.push(
      entries.length === 0
        ? "spot-check.json holds no judgments."
        : marked.length === 0
          ? `The owner has marked none of the ${entries.length} judgments in spot-check.json.`
          : `The owner marked ${marked.length} of ${entries.length} judgments in spot-check.json and agrees with ${agree}.`,
    );
    if (unmatched > 0) {
      lines.push(
        `${unmatched} marked ${unmatched === 1 ? "entry has" : "entries have"} no judgment in results.jsonl and ${unmatched === 1 ? "is" : "are"} not counted.`,
      );
    }
    if (entries.length < SPOT_CHECK_SIZE) {
      lines.push(
        `Spec \u00A79 asks for ${SPOT_CHECK_SIZE}; this spot-check has ${entries.length}.`,
      );
    }
    lines.push(
      ...compared
        .filter((j) => j.owner !== j.judge)
        .map(
          (j) =>
            `- Disagrees on ${cell(j.questionId)} (${j.agent}): the judge gave ${j.judge}, the owner ${j.owner}. The judge's reason: ${cell(j.reason, 500)}`,
        ),
      "",
    );
  }
  const { agentUsd, judgeUsd } = summary;
  const failed = records.some((r) => r.kind === "judge-failure");
  const money = (x: number | null) => (x === null ? "unknown" : usd(x));
  const all = agentUsd === null || judgeUsd === null ? null : agentUsd + judgeUsd;
  lines.push(
    "## Cost",
    "",
    `Agents ${money(agentUsd)}, judge ${money(judgeUsd)}${failed ? " (failed judgments included)" : ""}: ${money(all)} in all${all === null ? ": a call's model has no price." : ", at the models' list prices."}`,
  );
  return `${lines.join("\n")}\n`;
}

export const REPORT_FILE = "report.md";

/**
 * Writes a run directory's report.md from its run.json, results and spot-check.json, first
 * writing spot-check.json once every answer is judged; a spot-check file that exists is never
 * written over, since it holds the owner's grades. report.md is replaced atomically.
 */
export function writeReport(runDir: string): { summary: EvalSummary; reportPath: string } {
  const info = readRunInfo(runDir);
  const records = readRecords(runDir);
  checkRecords(runDir, info, records);
  const summary = summarize(info, records);
  const spotPath = join(runDir, SPOT_CHECK_FILE);
  if (summary.complete && !existsSync(spotPath)) {
    createOnce(spotPath, `${JSON.stringify(spotCheckSample(info, records), null, 2)}\n`);
  }
  let spotCheck: SpotCheck | null = null;
  if (existsSync(spotPath)) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(spotPath, "utf8"));
    } catch (error) {
      throw new EvalRunError(
        `${spotPath} is not a valid spot-check file: it is not JSON; move it aside to draw a new sample`,
        { cause: error },
      );
    }
    const parsed = SpotCheck.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.map(String).join(".") || "the file";
      throw new EvalRunError(
        `${spotPath} is not a valid spot-check file: ${oneLine(`${where}: ${issue?.message ?? "invalid"}`).slice(0, 200)}; set "owner" to the number 0 or 1, or move the file aside to draw a new sample`,
        { cause: parsed.error },
      );
    }
    spotCheck = parsed.data;
    const { run } = spotCheck;
    if (
      run.startedAt !== info.startedAt ||
      run.set !== info.set ||
      run.repo !== info.repo ||
      run.head !== info.head
    ) {
      throw new EvalRunError(
        `${spotPath} is from another run (begun ${oneLine(run.startedAt)}), not this one (begun ${info.startedAt}); move it aside to draw a new sample`,
      );
    }
  }
  const reportPath = join(runDir, REPORT_FILE);
  const temporary = `${reportPath}.${process.pid}.tmp`;
  try {
    // The temporary name is this process's own, so a stale one a killed run left is written over.
    writeFileSync(temporary, renderReport(summary, records, spotCheck));
    renameSync(temporary, reportPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { summary, reportPath };
}
