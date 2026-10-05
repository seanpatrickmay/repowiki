import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  addAliases,
  architectureSystemPrompt,
  buildFileGraph,
  buildJournal,
  buildPack,
  buildWiki,
  codeAliases,
  DEFAULT_ARCHITECTURE_BUDGET_TOKENS,
  DEFAULT_MAX_FILE_BYTES,
  featureNeighbours,
  indexRepo,
  MIN_ARCHITECTURE_PAGES,
  openStore,
  readHistory,
  readSources,
  resolveCommit,
  StoreError,
  WikiBuildError,
  writeExport,
  writeSystemPrompt,
} from "@repowiki/engine";
import { createLedger, type ModelConfig, totalsOf } from "@repowiki/llm";
import { CliError, exitCodeFor, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import {
  acquireBuildLock,
  estimateArchitecture,
  estimateBuild,
  exitWithError,
  lazyClaudeProvider,
  parseWikiArgs,
  renderBuildSummary,
  WIKI_BUILD_RUN_PREFIX,
  type WikiArgs,
} from "./wiki-cli.ts";

async function main(): Promise<void> {
  const args = parseWikiArgs(process.argv.slice(2));
  const repo = resolve(args.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new CliError(`no such repository: ${args.repo}`);
  }
  const repoName = basename(repo);
  const out = resolveOutDir(repo, args.out ?? join(homedir(), ".repowiki", repoName));
  if (out === null) {
    throw new CliError(
      "refusing to write inside the documented repository; choose an --out path elsewhere",
    );
  }
  const models = loadModels(args.config);
  // The rev is resolved first, so a typo leaves no out dir behind.
  const sha = resolveCommit(repo, args.rev);
  mkdirSync(out, { recursive: true });
  // A dry run sends nothing, so only a real build needs the out dir to itself.
  const release = args.dryRun ? () => {} : acquireBuildLock(out, (line) => console.error(line));
  try {
    await runBuild({ ...args, rev: sha }, repo, out, models);
  } finally {
    release();
  }
}

/** The build itself, run while this process holds the out dir's lock. */
async function runBuild(
  args: WikiArgs,
  repo: string,
  out: string,
  models: ModelConfig,
): Promise<void> {
  const repoName = basename(repo);
  const index = await indexRepo(repo, args.rev);
  const history = readHistory(repo, index.sha);
  const sources = await readSources(repo, index.sha, DEFAULT_MAX_FILE_BYTES);
  const graph = buildFileGraph(index);
  const store = openStore(join(out, "wiki.db"));
  try {
    const stored = store.getManifest(index.sha);
    if (stored === null) {
      throw new WikiBuildError(
        `no manifest for ${index.sha} in ${join(out, "wiki.db")}; run pnpm manifest:build first`,
      );
    }
    // The estimate is stated before any call (owner directive), from the packs the build sends:
    // those of the manifest with its code aliases, computed here in memory as buildWiki stores it.
    const manifest = addAliases(stored, codeAliases(stored, sources));
    const neighbours = featureNeighbours(graph, manifest);
    const active = manifest.features.filter((f) => f.status.kind === "active");
    const todo = active.filter((f) => store.getCurrentRevision(f.id) === null);
    const packs = todo.map((f) =>
      buildPack({
        featureId: f.id,
        manifest,
        index,
        sources,
        history,
        neighbours: neighbours.get(f.id) ?? new Map(),
        budgetTokens: args.budgetTokens,
      }),
    );
    const estimate = estimateBuild(
      packs,
      writeSystemPrompt(repoName, manifest),
      models.write,
      args.batch,
    );
    console.error(
      `${estimate.pages} pages to write, about ${estimate.inputTokens.toLocaleString("en-US")} input tokens: first round estimated at $${estimate.usd.toFixed(4)}${args.batch ? " (batched)" : ""}`,
    );
    // The project's article is due unless the stored one covers exactly the current pages.
    const current = store.getCurrentArchitecture();
    const basis = active
      .flatMap((f) => store.getCurrentRevision(f.id) ?? [])
      .map((p) => p.id)
      .sort();
    const architectureDue =
      active.length >= MIN_ARCHITECTURE_PAGES &&
      (todo.length > 0 ||
        current === null ||
        current.sha !== index.sha ||
        current.basis.join("\n") !== basis.join("\n"));
    if (architectureDue) {
      const architecture = estimateArchitecture(
        architectureSystemPrompt(repoName, manifest),
        DEFAULT_ARCHITECTURE_BUDGET_TOKENS,
        models.write,
        args.batch,
      );
      estimate.architectureUsd = architecture.usd;
      console.error(
        `the About article: at most about ${architecture.inputTokens.toLocaleString("en-US")} input tokens, estimated at $${architecture.usd.toFixed(4)}${args.batch ? " (batched)" : ""}`,
      );
    }
    if (args.dryRun) return;

    const runId = `${WIKI_BUILD_RUN_PREFIX}${index.sha}-${new Date().toISOString()}`;
    const ledger = createLedger((entry) => store.appendLedger(entry));
    // Forgets a collected request only once buildWiki stores its page, so a kill never re-pays.
    const journal = buildJournal(store);
    // Built on the first call, so a run with nothing left to write needs no API key.
    const provider = lazyClaudeProvider({
      command: "wiki:build",
      models,
      ledger,
      runId,
      run: { kind: "build", sha: index.sha },
      journal,
      deadlineMinutes: args.deadlineMinutes,
      log: (line) => console.error(line),
    });
    const build = await buildWiki(
      store,
      { index, sources, history, graph },
      {
        provider,
        journal,
        repoName,
        batch: args.batch,
        budgetTokens: args.budgetTokens,
        log: (line) => console.error(line),
      },
    );
    const exportPath = join(out, "export.json");
    writeExport(store, exportPath, { repo: repoName, exportedAt: new Date().toISOString() });
    if (build.written === null && build.architecture === null) {
      const article =
        build.architectureSkipped === "current" ? ", and so is the About article" : "";
      console.error(`every page is already stored for ${index.sha}${article}; no LLM call made`);
      console.log(`Wrote ${exportPath}`);
      return;
    }
    const summary = renderBuildSummary(
      repoName,
      index.sha,
      build.written?.pages ?? [],
      estimate,
      totalsOf(store.listLedger(runId)),
      { outcome: build.architecture, skipped: build.architectureSkipped },
    );
    const summaryPath = join(out, `build-${index.sha.slice(0, 7)}.md`);
    writeFileSync(summaryPath, summary);
    console.log(summary);
    console.log(`Wrote ${exportPath} and ${summaryPath}; store: ${join(out, "wiki.db")}`);
  } finally {
    store.close();
  }
}

try {
  await main();
} catch (err) {
  exitWithError(err);
}
