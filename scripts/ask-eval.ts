import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { askIndexes } from "@repowiki/ask";
import { WikiBuildError } from "@repowiki/engine";
import { loadQuestions, QuestionFileError, selectQuestions } from "@repowiki/eval";
import { createClaudeProvider, createClaudeToolProvider, createLedger } from "@repowiki/llm";
import { loadExport, WikiView } from "@repowiki/query";
import { askEvalEstimateLine, estimateAskEval, parseAskEvalArgs } from "./ask-eval-cli.ts";
import { renderAskReport, runAskEval } from "./ask-eval-run.ts";
import { logLine } from "./eval-cli.ts";
import { CliError, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { typicalQuestionUsd } from "./serve-cli.ts";
import { exitWithError, requireApiKey } from "./wiki-cli.ts";

/**
 * pnpm ask:eval <repo> --questions <file> (spec v2 #4 §7): asks the dev set of the M7 question
 * file through the ask (no cache), judges each answer with the M7 judge, and writes report.md and
 * results.json to <out>/eval/ask-<time>/. States its estimate first; --dry-run stops there.
 * Never runs the held-out set (R25) and never writes in <repo>.
 */
async function main(): Promise<void> {
  const args = parseAskEvalArgs(process.argv.slice(2));
  const repo = resolve(args.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new CliError(`no such repository: ${args.repo}`);
  }
  const out = resolveOutDir(repo, args.out ?? join(homedir(), ".repowiki", basename(repo)));
  if (out === null) {
    throw new CliError(
      "refusing to write inside the documented repository; choose an --out path elsewhere",
    );
  }
  const exportPath = join(out, "export.json");
  if (!existsSync(exportPath)) {
    throw new WikiBuildError(`no export at ${exportPath}; run pnpm wiki:build first`);
  }
  const wiki = loadExport(exportPath);
  let questionsPath: string;
  try {
    questionsPath = realpathSync(args.questions);
  } catch {
    throw new CliError(`cannot read question file ${args.questions}`);
  }
  if (resolveOutDir(repo, dirname(questionsPath)) === null) {
    throw new CliError("the question file is inside the documented repository; keep it elsewhere");
  }
  let loaded: ReturnType<typeof loadQuestions>;
  let questions: ReturnType<typeof selectQuestions>;
  try {
    loaded = loadQuestions(questionsPath);
    questions = selectQuestions(loaded.file, args.set);
  } catch (err) {
    if (err instanceof QuestionFileError) throw new CliError(err.message, { cause: err });
    throw err;
  }
  if (loaded.file.repo !== wiki.repo) {
    throw new CliError(
      `the question file is about ${JSON.stringify(loaded.file.repo)}, but the wiki in ${out} is ${JSON.stringify(wiki.repo)}`,
    );
  }
  const models = loadModels(args.config);
  const estimate = estimateAskEval({
    questions,
    typicalUsd: typicalQuestionUsd(wiki, models.ask),
    judgeModel: models.evalJudge,
    batchJudge: args.batch,
  });
  console.error(askEvalEstimateLine(estimate, args));
  if (args.dryRun) return;
  requireApiKey("ask:eval");
  const now = new Date();
  const runDir = join(out, "eval", `ask-${now.toISOString().replace(/[:.]/g, "-")}`);
  const ledger = createLedger();
  const runId = `ask-eval-${now.toISOString()}`;
  const view = new WikiView(wiki);
  const result = await runAskEval({
    view,
    indexes: askIndexes(view),
    questions,
    provider: createClaudeToolProvider({ models, ledger, runId }),
    judge: createClaudeProvider({ models, ledger, runId }),
    model: models.ask,
    batchJudge: args.batch,
    maxUsd: args.maxUsd,
    perQuestionCeilingUsd: estimate.perQuestionCeilingUsd,
    log: logLine,
  });
  mkdirSync(runDir, { recursive: true });
  const startedAt = now.toISOString();
  writeFileSync(
    join(runDir, "results.json"),
    `${JSON.stringify({ repo: wiki.repo, head: wiki.head, model: models.ask, set: args.set, questionsHash: loaded.hash, startedAt, ...result }, null, 2)}\n`,
  );
  const report = join(runDir, "report.md");
  writeFileSync(
    report,
    renderAskReport({
      repo: wiki.repo,
      head: wiki.head,
      model: models.ask,
      set: args.set,
      startedAt,
      result,
    }),
  );
  const correct = result.rows.filter((r) => r.score === 1).length;
  console.log(
    `ask ${correct} of ${result.rows.length}; this run cost $${result.spentUsd.toFixed(4)}${result.overBudget.length > 0 ? `; ${result.overBudget.length} not asked (--max-usd)` : ""}`,
  );
  console.log(`Wrote ${report}`);
}

try {
  await main();
} catch (err) {
  exitWithError(err);
}
