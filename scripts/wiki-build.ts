import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  buildFileGraph,
  buildPack,
  buildWiki,
  DEFAULT_MAX_FILE_BYTES,
  featureNeighbours,
  indexRepo,
  openStore,
  readHistory,
  readSources,
  StoreError,
  WikiBuildError,
  writeExport,
  writeSystemPrompt,
} from "@repowiki/engine";
import { createClaudeProvider, createLedger, type Provider, totalsOf } from "@repowiki/llm";
import { CliError, exitCodeFor, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { estimateBuild, parseWikiArgs, renderBuildSummary } from "./wiki-cli.ts";

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
  const index = await indexRepo(repo, args.rev);
  const history = readHistory(repo, index.sha);
  const sources = readSources(repo, index.sha, DEFAULT_MAX_FILE_BYTES);
  const graph = buildFileGraph(index);
  mkdirSync(out, { recursive: true });
  const store = openStore(join(out, "wiki.db"));
  try {
    const manifest = store.getManifest(index.sha);
    if (manifest === null) {
      throw new WikiBuildError(
        `no manifest for ${index.sha} in ${join(out, "wiki.db")}; run pnpm manifest:build first`,
      );
    }
    // The estimate is stated before any call (owner directive), from the packs the build sends.
    const neighbours = featureNeighbours(graph, manifest);
    const todo = manifest.features.filter(
      (f) => f.status.kind === "active" && store.getCurrentRevision(f.id) === null,
    );
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
    if (args.dryRun) return;

    const runId = `wiki-build-${index.sha}-${new Date().toISOString()}`;
    const ledger = createLedger((entry) => store.appendLedger(entry));
    // Built on the first call, so a run with nothing left to write needs no API key.
    let claude: Provider | undefined;
    const provider: Provider = {
      generate: (request) => {
        claude ??= createClaudeProvider({
          models,
          ledger,
          runId,
          run: { kind: "build", sha: index.sha },
          batchJournal: {
            lookup: (key) => store.findBatchRequest(key),
            record: (batchId, createdAt, items) =>
              store.recordBatchRequests(batchId, createdAt, items),
            forget: (batchId, keys) => store.forgetBatchRequests(batchId, keys),
          },
          ...(args.deadlineMinutes === null
            ? {}
            : { batchDeadlineMs: args.deadlineMinutes * 60_000 }),
          onBatchCreated: (b) => console.error(`batch ${b.id} created (${b.requests} requests)`),
          onBatchProgress: (p) =>
            console.error(
              `batch ${p.id}: ${p.status} (${p.processing} processing, ${p.succeeded} done)`,
            ),
        });
        return claude.generate(request);
      },
    };
    const build = await buildWiki(
      store,
      { index, sources, history, graph },
      {
        provider,
        repoName,
        batch: args.batch,
        budgetTokens: args.budgetTokens,
        log: (line) => console.error(line),
      },
    );
    const exportPath = join(out, "export.json");
    writeExport(store, exportPath, { repo: repoName, exportedAt: new Date().toISOString() });
    if (build.written === null) {
      console.error(`every page is already stored for ${index.sha}; no LLM call made`);
      console.log(`Wrote ${exportPath}`);
      return;
    }
    const summary = renderBuildSummary(
      repoName,
      index.sha,
      build.written.pages,
      estimate,
      totalsOf(store.listLedger(runId)),
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
  const code = err instanceof WikiBuildError || err instanceof StoreError ? 1 : exitCodeFor(err);
  if (code === null) throw err;
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(code);
}
