import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ASK_TURN_TIMEOUT_MS, askIndexes } from "@repowiki/ask";
import { WikiBuildError } from "@repowiki/engine";
import { loadQuestions, QuestionFileError, selectQuestions } from "@repowiki/eval";
import { createClaudeProvider, createClaudeToolProvider, createLedger } from "@repowiki/llm";
import { loadExport, WikiView } from "@repowiki/query";
import { askEvalEstimateLine, estimateAskEval, parseAskEvalArgs } from "./ask-eval-cli.ts";
import { checkAskableQuestions, renderAskReport, runAskEval } from "./ask-eval-run.ts";
import {
  baselineGate,
  criteriaLines,
  devBaseline,
  readSheetEntries,
  SUPPORT_ENTRIES_FILE,
  supportSheet,
  tallySupport,
} from "./ask-eval-sheet.ts";
import { logLine } from "./eval-cli.ts";
import { CliError, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { typicalQuestionUsd } from "./serve-cli.ts";
import { exitWithError, requireApiKey, writeFileAtomic } from "./wiki-cli.ts";

/**
 * pnpm ask:eval <repo> --questions <file> (spec v2 #4 §7): asks the dev set of the M7 question
 * file through the ask (no cache), judges each answer with the M7 judge, and writes report.md and
 * results.json to <out>/eval/ask-<time>/, with support.md for the owner's blind checks and the
 * comparison with his latest complete eval:run dev run (§12.2). States its estimate first, then
 * stops (exit 1) when there is no such run, unless --no-baseline; --dry-run stops there. Never runs the held-out set (R25) and never writes in <repo>.
 * `pnpm ask:eval tally <support.md>` counts a marked support sheet against the entries recorded
 * beside it (support-entries.json).
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "tally") return tally(argv.slice(1));
  const args = parseAskEvalArgs(argv);
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
  checkAskableQuestions(questions);
  const models = loadModels(args.config);
  const estimate = estimateAskEval({
    questions,
    typicalUsd: typicalQuestionUsd(wiki, models.ask),
    judgeModel: models.evalJudge,
    batchJudge: args.batch,
  });
  console.error(askEvalEstimateLine(estimate, args));
  // The comparison the run exists for is found before any paid call (spec v2 #4 §12.2).
  const baseline =
    args.set === "dev" ? devBaseline(out, loaded.hash, (line) => console.error(line)) : null;
  const gate = baselineGate({
    set: args.set,
    required: args.baseline,
    dryRun: args.dryRun,
    baseline,
    evalDir: join(out, "eval"),
  });
  if (gate.line !== null) console.error(gate.line);
  if (gate.stop) {
    process.exitCode = gate.exitCode;
    return;
  }
  if (args.dryRun) return;
  requireApiKey("ask:eval");
  const now = new Date();
  const runDir = join(out, "eval", `ask-${now.toISOString().replace(/[:.]/g, "-")}`);
  const ledger = createLedger();
  const runId = `ask-eval-${now.toISOString()}`;
  const view = new WikiView(wiki);
  const startedAt = now.toISOString();
  mkdirSync(runDir, { recursive: true });
  const header = {
    repo: wiki.repo,
    head: wiki.head,
    model: models.ask,
    set: args.set,
    questionsHash: loaded.hash,
    startedAt,
  };
  const result = await runAskEval({
    view,
    indexes: askIndexes(view),
    questions,
    provider: createClaudeToolProvider({ models, ledger, runId, timeoutMs: ASK_TURN_TIMEOUT_MS }),
    judge: createClaudeProvider({ models, ledger, runId }),
    model: models.ask,
    judgeModel: models.evalJudge,
    batchJudge: args.batch,
    maxUsd: args.maxUsd,
    perQuestionCeilingUsd: estimate.perQuestionCeilingUsd,
    log: logLine,
    // Each question's result, rewritten whole as it completes: a crash keeps what was paid for.
    record: (progress) =>
      writeFileAtomic(
        join(runDir, "results.json"),
        `${JSON.stringify({ ...header, ...progress }, null, 2)}\n`,
      ),
  });
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
      extra: criteriaLines(result, baseline, { set: args.set, head: wiki.head }),
    }),
  );
  const sheet = supportSheet(view, result, { repo: wiki.repo, head: wiki.head, startedAt });
  writeFileSync(join(runDir, "support.md"), sheet.text);
  writeFileSync(join(runDir, SUPPORT_ENTRIES_FILE), `${JSON.stringify(sheet.entries, null, 2)}\n`);
  const correct = result.rows.filter((r) => r.score === 1).length;
  console.log(
    `ask ${correct} of ${result.rows.length}; this run cost $${result.spentUsd.toFixed(4)}${result.overBudget.length > 0 ? `; ${result.overBudget.length} not asked (--max-usd)` : ""}`,
  );
  console.log(`Wrote ${report}`);
}

const TALLY_USAGE = "usage: pnpm ask:eval tally <support.md>";

/** `pnpm ask:eval tally <support.md>`: the owner's marks, counted (spec v2 #4 §12.3-4). */
function tally(argv: readonly string[]): void {
  const [file, ...extra] = argv;
  if (file === undefined || file === "" || extra.length > 0) throw new CliError(TALLY_USAGE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new CliError(`cannot read ${file}`);
  }
  const entriesPath = join(dirname(file), SUPPORT_ENTRIES_FILE);
  let entriesText: string;
  try {
    entriesText = readFileSync(entriesPath, "utf8");
  } catch {
    throw new CliError(
      `no ${SUPPORT_ENTRIES_FILE} beside ${file}: tally counts a sheet as ask:eval wrote it`,
    );
  }
  let counted: ReturnType<typeof tallySupport>;
  try {
    counted = tallySupport(text, readSheetEntries(entriesText));
  } catch (err) {
    throw new CliError(`${file}: ${(err as Error).message}`, { cause: err });
  }
  const line = (name: string, c: (typeof counted)["support"], what: string) =>
    `${name}: ${c.yes} of ${c.lines} ${what}, ${c.no} not, ${c.unmarked} unmarked: ${c.pass ? "passes" : "does not pass"}`;
  console.log(line("support", counted.support, "supported by their cited claims"));
  console.log(line("routing", counted.routing, "routed to the right first page"));
}

try {
  await main();
} catch (err) {
  exitWithError(err);
}
