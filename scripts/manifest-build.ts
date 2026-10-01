import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureManifest, indexRepo, openStore, renderManifestSummary } from "@repowiki/engine";
import { createClaudeProvider, createLedger, resolveModels } from "@repowiki/llm";
import { resolveOutDir } from "./out-dir.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    config: { type: "string" },
    "no-batch": { type: "boolean", default: false },
  },
});
const [repoArg, rev = "HEAD"] = positionals;
if (repoArg === undefined) {
  console.error(
    "usage: pnpm manifest:build <repo-path> [rev] [--out dir] [--config file.json] [--no-batch]",
  );
  process.exit(2);
}
const repo = resolve(repoArg);
const repoName = basename(repo);
const out = resolveOutDir(repo, values.out ?? join(homedir(), ".repowiki", repoName));
if (out === null) {
  console.error(
    "refusing to write inside the documented repository; choose an --out path elsewhere",
  );
  process.exit(2);
}
const models = resolveModels(
  values.config === undefined ? {} : JSON.parse(readFileSync(values.config, "utf8")),
);

const index = await indexRepo(repo, rev);
mkdirSync(out, { recursive: true });
const store = openStore(join(out, "wiki.db"));
try {
  const runId = `manifest-build-${new Date().toISOString()}`;
  const ledger = createLedger((entry) => store.appendLedger(entry));
  const provider = createClaudeProvider({
    models,
    ledger,
    runId,
    onBatchProgress: (p) =>
      console.error(`batch ${p.id}: ${p.status} (${p.processing} processing, ${p.succeeded} done)`),
  });
  const { manifest, build } = await ensureManifest(store, index, {
    provider,
    repoName,
    batch: !values["no-batch"],
  });
  if (build === null) console.error(`reusing the stored manifest for ${index.sha}`);
  else {
    console.error(`${build.clusters.length} clusters, prompt about ${build.promptTokens} tokens`);
    if (build.rejected.length > 0) {
      console.error(`first answer rejected, retried once: ${build.rejected.join("; ")}`);
    }
  }
  const summary = renderManifestSummary(
    repoName,
    manifest,
    build === null ? null : ledger.totals(),
  );
  const stem = join(out, `manifest-${index.sha.slice(0, 7)}`);
  writeFileSync(`${stem}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(`${stem}.md`, summary);
  console.log(summary);
  console.log(`Wrote ${stem}.json and ${stem}.md for review; store: ${join(out, "wiki.db")}`);
} finally {
  store.close();
}
