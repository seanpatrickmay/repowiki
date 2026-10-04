import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visibleText } from "./judge.ts";
import type { AgentKind } from "./prompts.ts";
import type { QuestionKind } from "./questions.ts";
import { AGENTS, EvalRunError, type RunRecord, readRecords, readRunInfo } from "./records.ts";
import {
  SPOT_CHECK_FILE,
  SPOT_CHECK_SIZE,
  SpotCheck,
  spotCheckEntry,
  spotCheckSample,
} from "./spot-check.ts";
import {
  ACCURACY_SHARE,
  type EvalSummary,
  latestRecords,
  summarize,
  TOKEN_SHARE,
  tokensOf,
} from "./summary.ts";
import { cut, oneLine } from "./text.ts";

const count = (n: number) => Math.round(n).toLocaleString("en-US");
const percent = (x: number) => `${Math.round(x * 1000) / 10}%`;
const usd = (x: number) => `$${x.toFixed(4)}`;
/** Model or author text in a table cell: one line, cut short, no pipe to split the row. */
const cell = (text: string, max = 120) => cut(oneLine(text), max).replace(/\|/g, "\\|");
const KINDS: readonly QuestionKind[] = ["where", "how", "why", "what-changed"];

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
    `${n} questions, each asked to both agents with ${cell(info.models.evalAgent, 60)} and a limit of ${info.turnLimit} turns, and judged by ${cell(info.models.evalJudge, 60)}. The wiki is the export at commit ${info.head.slice(0, 7)}; the repo agent read the repository at the same commit.${info.writtenOn === null ? "" : ` The author wrote the questions on ${info.writtenOn}, by his statement.`} The run began ${info.startedAt}.`,
    "",
  ];
  if (info.set === "smoke") {
    lines.push(
      "This is the smoke set: questions about the test fixture that check the harness. It measures nothing.",
      "",
    );
  } else if (info.set === "dev") {
    lines.push(
      "This is the dev set: its figures track progress. Spec §9's pass test binds only on the held-out set.",
      "",
    );
  }
  if (!complete) {
    const missing = AGENTS.reduce((s, a) => s + n - agents[a].answered, 0);
    const unjudged = AGENTS.reduce((s, a) => s + agents[a].answered - agents[a].judged, 0);
    lines.push(
      `Incomplete: ${missing} answers and ${unjudged} judgments missing. Run pnpm eval:run again with the same run directory to finish; no question is asked twice.`,
      "",
    );
  }
  lines.push(
    "| Agent | Correct | Accuracy | Tokens per question | Cost per question | Answered on the last turn |",
    "|---|---:|---:|---:|---:|---:|",
    ...AGENTS.map((a) => {
      const s = agents[a];
      return `| ${a} | ${s.correct} of ${n} | ${s.accuracy === null ? "-" : percent(s.accuracy)} | ${s.tokensPerQuestion === null ? "-" : count(s.tokensPerQuestion)} | ${s.usdPerQuestion === null ? "-" : usd(s.usdPerQuestion)} | ${s.lastTurn} |`;
    }),
    "",
  );
  if (summary.pass !== null) {
    const { wiki, repo } = agents;
    const wAcc = wiki.accuracy ?? 0;
    const rAcc = repo.accuracy ?? 0;
    const wTok = wiki.tokensPerQuestion ?? 0;
    const rTok = repo.tokensPerQuestion ?? 0;
    lines.push(
      "## Pass test (spec §9)",
      "",
      `- Accuracy: the wiki agent's ${percent(wAcc)} against at least ${percent(ACCURACY_SHARE * rAcc)} (90% of the repo agent's ${percent(rAcc)}): ${summary.pass.accuracy ? "met" : "not met"}.`,
      `- Tokens: the wiki agent's ${count(wTok)} per question against at most ${count(TOKEN_SHARE * rTok)} (40% of the repo agent's ${count(rTok)}): ${summary.pass.tokens ? "met" : "not met"}.`,
      "",
      `Result on this set: ${summary.pass.accuracy && summary.pass.tokens ? "pass" : "fail"}.`,
      "",
    );
  }
  lines.push("## Break-even", "");
  if (info.buildTokens === null) {
    lines.push(
      "Unknown: the export records no build run, so the build's tokens are not known.",
      "",
    );
  } else if (summary.breakEven === "never") {
    lines.push(
      `Never: the wiki agent used no fewer tokens per question than the repo agent, so the build's ${count(info.buildTokens)} tokens are never paid back.`,
      "",
    );
  } else if (summary.breakEven !== null) {
    const saved = (agents.repo.tokensPerQuestion ?? 0) - (agents.wiki.tokensPerQuestion ?? 0);
    lines.push(
      `The build cost ${count(info.buildTokens)} tokens. Each question answered from the wiki instead of the code saves ${count(saved)} tokens, so the build pays for itself after ${Math.ceil(summary.breakEven).toLocaleString("en-US")} questions (${count(info.buildTokens)} / ${count(saved)}).`,
      "",
    );
  }
  lines.push(
    "## By kind",
    "",
    "| Kind | Questions | Wiki correct | Repo correct |",
    "|---|---:|---:|---:|",
  );
  for (const kind of KINDS) {
    const of = info.questions.filter((q) => q.kind === kind);
    if (of.length === 0) continue;
    const right = (a: AgentKind) =>
      of.filter((q) => judgments.get(`${q.id}\0${a}`)?.score === 1).length;
    lines.push(`| ${kind} | ${of.length} | ${right("wiki")} | ${right("repo")} |`);
  }
  lines.push(
    "",
    "## Questions",
    "",
    "| Question | Kind | Wiki | Repo | Wiki tokens | Repo tokens | Wiki turns | Repo turns |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const q of info.questions) {
    const at = (a: AgentKind) => ({
      a: answers.get(`${q.id}\0${a}`),
      j: judgments.get(`${q.id}\0${a}`),
    });
    const w = at("wiki");
    const r = at("repo");
    const score = (x: typeof w) => (x.j === undefined ? "-" : String(x.j.score));
    const tokens = (x: typeof w) => (x.a === undefined ? "-" : count(tokensOf(x.a.usage)));
    const turns = (x: typeof w) => (x.a === undefined ? "-" : String(x.a.turns));
    lines.push(
      `| ${cell(q.id)} | ${q.kind} | ${score(w)} | ${score(r)} | ${tokens(w)} | ${tokens(r)} | ${turns(w)} | ${turns(r)} |`,
    );
  }
  lines.push("", "## The judge's reasons", "");
  for (const q of info.questions) {
    lines.push(`- ${cell(q.id)}: ${cell(q.question, 200)}`);
    for (const a of AGENTS) {
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
      lines.push(`Spec §9 asks for ${SPOT_CHECK_SIZE}; this spot-check has ${entries.length}.`);
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
  lines.push(
    "## Cost",
    "",
    `Agents ${usd(summary.agentUsd)}, judge ${usd(summary.judgeUsd)}: ${usd(summary.agentUsd + summary.judgeUsd)} in all, at the models' list prices.`,
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
  const summary = summarize(info, records);
  const spotPath = join(runDir, SPOT_CHECK_FILE);
  if (summary.complete && !existsSync(spotPath)) {
    const sample = spotCheckSample(info, records);
    writeFileSync(spotPath, `${JSON.stringify(sample, null, 2)}\n`, { flag: "wx" });
  }
  let spotCheck: SpotCheck | null = null;
  if (existsSync(spotPath)) {
    try {
      spotCheck = SpotCheck.parse(JSON.parse(readFileSync(spotPath, "utf8")));
    } catch (error) {
      throw new EvalRunError(`${spotPath} is not a valid spot-check file`, { cause: error });
    }
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
    writeFileSync(temporary, renderReport(summary, records, spotCheck), { flag: "wx" });
    renameSync(temporary, reportPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { summary, reportPath };
}
