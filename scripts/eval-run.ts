import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { WikiExport } from "@repowiki/core";
import {
  buildJournal,
  openStore,
  resolveCommit,
  type Store,
  WikiBuildError,
} from "@repowiki/engine";
import {
  type AgentKind,
  buildTokensOf,
  combineToolSets,
  createRepoTools,
  createWikiTools,
  defaultAgents,
  EvalRunError,
  loadQuestions,
  type McpAgentTools,
  openMcpTools,
  QuestionFileError,
  RUN_INFO_FILE,
  type RunInfo,
  readRecords,
  readRunInfo,
  selectQuestions,
  summarize,
  type ToolSet,
  writeReport,
} from "@repowiki/eval";
import { createClaudeToolProvider, createLedger } from "@repowiki/llm";
import {
  createJudgeProvider,
  estimateEval,
  estimateLine,
  logLine,
  parseEvalArgs,
  requireSameExport,
  runDirFor,
  runEvalJournaled,
  scoreLine,
} from "./eval-cli.ts";
import { CliError, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { acquireBuildLock, exitWithError, requireApiKey } from "./wiki-cli.ts";

/**
 * pnpm eval:run <repo> --questions <file> --set <set>: spec §9's Q&A eval. Asks each question of
 * the set to the wiki agent (the export in the out dir) and the repo agent (the repository at the
 * wiki's commit), judges every answer, and writes run.json, results.jsonl, report.md and, once
 * every answer is judged, spot-check.json in the run directory (writeReport). States its estimate before any
 * call; --dry-run stops there. The held-out set runs once: a second run resumes an unfinished one
 * and refuses a finished one. Holds the out dir's lock (and refuses an export that changed before
 * it was taken), and never writes in <repo>. The judge's
 * Message Batch is journaled in the wiki store (<out>/wiki.db, as wiki:build does), so a run
 * killed while it is in flight collects that batch on a rerun (with --run-dir, for the dev set).
 */
/** The MCP server the mcp agents use, when they run; closed however the run ends. */
const started: { mcp: McpAgentTools | null } = { mcp: null };

async function main(): Promise<void> {
  const args = parseEvalArgs(process.argv.slice(2));
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
  if (!existsSync(exportPath))
    throw new WikiBuildError(`no export at ${exportPath}; run pnpm wiki:build first`);
  const exportBytes = readFileSync(exportPath);
  const wiki = WikiExport.parse(JSON.parse(exportBytes.toString("utf8")));

  // The repo agent reads the repository: a question file inside it could be read back.
  let questionsPath: string;
  try {
    questionsPath = realpathSync(args.questions);
  } catch {
    throw new CliError(`cannot read question file ${args.questions}`);
  }
  if (resolveOutDir(repo, dirname(questionsPath)) === null) {
    throw new CliError(
      "the question file is inside the documented repository, where the repo agent could read it; keep it elsewhere",
    );
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
  if (resolveCommit(repo, wiki.head) !== wiki.head)
    throw new CliError(`${repo} does not hold ${wiki.head}`);
  const wikiTools = createWikiTools(wiki);
  const repoTools = createRepoTools(repo, wiki.head);
  const now = new Date();
  // The run directory is the one path a run writes: it goes through the out dir's check too.
  let chosenRunDir: string | null = null;
  if (args.runDir !== null) {
    chosenRunDir = resolveOutDir(repo, args.runDir);
    if (chosenRunDir === null) {
      throw new CliError(
        "refusing to write inside the documented repository; choose a --run-dir path elsewhere",
      );
    }
    if (chosenRunDir === resolveOutDir(repo, runDirFor(out, "held-out", null, now))) {
      throw new CliError(
        `${chosenRunDir} is the held-out set's run directory; choose another --run-dir for the ${args.set} set`,
      );
    }
  }
  const runDir = runDirFor(out, args.set, chosenRunDir, now);
  if (args.set === "held-out" && existsSync(join(runDir, RUN_INFO_FILE))) {
    const stored = readRunInfo(runDir);
    if (summarize(stored, readRecords(runDir)).complete) {
      throw new EvalRunError(
        `the held-out set has run once already (begun ${stored.startedAt}): its report is ${join(runDir, "report.md")}`,
      );
    }
  }
  const agents = args.agents ?? [...defaultAgents(args.set)];
  // The mcp agents use the MCP server through its real stdio transport, pinned at the wiki's head
  // (spec v2 #5 R19). A dry run starts it too: the estimate counts its tool definitions. The
  // server makes no call and writes nothing.
  if (agents.some((a) => a === "mcp" || a === "repo+mcp")) {
    started.mcp = await openMcpTools({ repo, out, compareTo: wiki.head });
  }
  const mcp = started.mcp;
  const tools: Partial<Record<AgentKind, ToolSet>> = {
    wiki: wikiTools,
    repo: repoTools,
    ...(mcp === null ? {} : { mcp: mcp.tools, "repo+mcp": combineToolSets(repoTools, mcp.tools) }),
  };
  const estimate = estimateEval({
    questions,
    repoName: wiki.repo,
    turnLimit: args.turnLimit,
    agents,
    tools: Object.fromEntries(agents.map((a) => [a, tools[a]?.definitions ?? []])),
    models,
    batchJudge: args.batch,
  });
  console.error(estimateLine(estimate, args));
  if (buildTokensOf(wiki) === null) {
    console.error(
      "export.json records no build run, so the report cannot state a break-even; re-run pnpm wiki:export to include build tokens first",
    );
  }
  if (args.dryRun) return;
  requireApiKey("eval:run");
  const release = acquireBuildLock(out, (line) => console.error(line));
  let store: Store | undefined;
  try {
    // From the lock on the export cannot change; it must still be the one read above.
    requireSameExport(exportPath, exportBytes);
    // Printed whole, like the "Wrote" line: logLine would cut a long path, and it must be copied.
    console.error(
      args.set === "held-out"
        ? `run directory: ${runDir} (a rerun resumes it)`
        : `run directory: ${runDir} (rerun with --run-dir ${runDir} to resume)`,
    );
    // The wiki store is only opened, never created: the journal rows go in the build's own file.
    const storePath = join(out, "wiki.db");
    if (!existsSync(storePath)) {
      throw new WikiBuildError(
        `no wiki store at ${storePath}; run pnpm wiki:build first (eval:run keeps its batch journal there)`,
      );
    }
    store = openStore(storePath);
    const ledger = createLedger();
    const runId = `eval-${args.set}-${now.toISOString()}`;
    const log = logLine;
    const info: RunInfo = {
      set: args.set,
      repo: wiki.repo,
      head: wiki.head,
      exportHash: createHash("sha256").update(exportBytes).digest("hex"),
      questionsHash: loaded.hash,
      writtenOn: loaded.file.suite === "smoke" ? null : loaded.file.writtenOn,
      turnLimit: args.turnLimit,
      agents,
      models: { evalAgent: models.evalAgent, evalJudge: models.evalJudge },
      buildTokens: buildTokensOf(wiki),
      questions,
      startedAt: now.toISOString(),
    };
    // Forgets a collected judge request only once its judgment is in results.jsonl.
    const journal = buildJournal(store);
    const result = await runEvalJournaled(journal, {
      runDir,
      info,
      tools,
      agents: createClaudeToolProvider({ models, ledger, runId }),
      judge: createJudgeProvider({ models, ledger, runId, journal, log }),
      batchJudge: args.batch,
      maxUsd: args.maxUsd,
      log,
    });
    const { summary, reportPath } = writeReport(runDir);
    console.log(
      `${scoreLine(summary)}; this run cost $${result.spentUsd.toFixed(4)}${result.stopped === "budget" ? "; stopped at --max-usd" : ""}${result.unjudged > 0 ? `; ${result.unjudged} answers unjudged` : ""}`,
    );
    console.log(`Wrote ${reportPath}`);
  } finally {
    try {
      store?.close();
    } finally {
      release();
    }
  }
}

try {
  await main();
} catch (err) {
  await started.mcp?.close();
  exitWithError(err);
}
await started.mcp?.close();
