import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ensureManifest, indexRepo, openStore, renderManifestSummary } from "@repowiki/engine";
import { createClaudeProvider, createLedger, type Provider, totalsOf } from "@repowiki/llm";
import {
  CliError,
  exitCodeFor,
  loadModels,
  manifestLedgerRows,
  manifestRunId,
  parseManifestArgs,
} from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";

async function main(): Promise<void> {
  const args = parseManifestArgs(process.argv.slice(2));
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
  mkdirSync(out, { recursive: true });
  const store = openStore(join(out, "wiki.db"));
  try {
    const runId = manifestRunId(index.sha, new Date());
    const ledger = createLedger((entry) => store.appendLedger(entry));
    // Built on the first call, so a run that reuses the stored manifest needs no API key.
    let claude: Provider | undefined;
    const provider: Provider = {
      generate: (request) => {
        claude ??= createClaudeProvider({
          models,
          ledger,
          runId,
          batchJournal: {
            lookup: (key) => store.findBatchRequest(key),
            record: (batchId, createdAt, items) =>
              store.recordBatchRequests(batchId, createdAt, items),
            forget: (batchId, keys) => store.forgetBatchRequests(batchId, keys),
          },
          onBatchCreated: (batch) =>
            console.error(`batch ${batch.id} created (${batch.requests} requests)`),
          onBatchProgress: (p) =>
            console.error(
              `batch ${p.id}: ${p.status} (${p.processing} processing, ${p.succeeded} done)`,
            ),
        });
        return claude.generate(request);
      },
    };
    const { manifest, build } = await ensureManifest(store, index, {
      provider,
      repoName,
      batch: args.batch,
    });
    if (build === null) console.error(`reusing the stored manifest for ${index.sha}`);
    else {
      console.error(`${build.clusters.length} clusters, prompt about ${build.promptTokens} tokens`);
      if (build.rejected.length > 0) {
        console.error(`first answer rejected, retried once: ${build.rejected.join("; ")}`);
      }
    }
    // Every stored manifest call for this sha, so a reuse run reproduces the first run's cost.
    const recorded = manifestLedgerRows(store.listLedger(), index.sha);
    const summary = renderManifestSummary(
      repoName,
      manifest,
      recorded.length === 0 ? null : totalsOf(recorded),
    );
    const stem = join(out, `manifest-${index.sha.slice(0, 7)}`);
    writeFileSync(`${stem}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(`${stem}.md`, summary);
    console.log(summary);
    console.log(`Wrote ${stem}.json and ${stem}.md for review; store: ${join(out, "wiki.db")}`);
  } finally {
    store.close();
  }
}

try {
  await main();
} catch (err) {
  const code = exitCodeFor(err);
  if (code === null) throw err;
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(code);
}
