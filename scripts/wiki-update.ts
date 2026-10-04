import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  openStore,
  resolveCommit,
  StoreError,
  UpdateError,
  WikiBuildError,
  writeExport,
} from "@repowiki/engine";
import { totalsOf } from "@repowiki/llm";
import { CliError, exitCodeFor, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { estimateLine, parseUpdateArgs, renderUpdateSummary } from "./update-cli.ts";
import { estimateFor, needsKey, readInput, runUpdate } from "./update-run.ts";
import { acquireBuildLock, exitWithError, requireApiKey, writeFileAtomic } from "./wiki-cli.ts";

/**
 * pnpm wiki:update <repo> <rev>: moves the wiki stored for <repo> from its head to <rev> (spec
 * §6.1), stating the estimate first; --dry-run stops there. Holds the out dir's lock while it
 * runs, writes export.json and update-<sha7>.md next to wiki.db, and never writes in <repo>.
 */
async function main(): Promise<void> {
  const args = parseUpdateArgs(process.argv.slice(2));
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
  const db = join(out, "wiki.db");
  if (!existsSync(db)) throw new WikiBuildError(`no wiki at ${db}; run pnpm wiki:build first`);
  const models = loadModels(args.config);
  const sha = resolveCommit(repo, args.rev);
  const release = args.dryRun ? () => {} : acquireBuildLock(out, (line) => console.error(line));
  try {
    const store = openStore(db);
    try {
      const input = await readInput(repo, sha);
      const estimate = estimateFor(store, input, args, models, repoName);
      console.error(estimateLine(estimate, args.batch));
      if (args.dryRun) return;
      // Calls are certain, so fail once here rather than once per page; an update that makes
      // none (nothing cited changed, no article due) needs no key.
      if (needsKey(estimate)) requireApiKey("wiki:update");
      const log = (line: string) => console.error(line);
      const { update, runId } = await runUpdate(store, input, args, models, repoName, log);
      const exportPath = join(out, "export.json");
      writeExport(store, exportPath, { repo: repoName, exportedAt: new Date().toISOString() });
      const summary = renderUpdateSummary(
        repoName,
        update,
        estimate,
        totalsOf(store.listLedger(runId)),
      );
      const summaryPath = join(out, `update-${sha.slice(0, 7)}.md`);
      writeFileAtomic(summaryPath, summary);
      console.log(summary);
      console.log(`Wrote ${exportPath} and ${summaryPath}; store: ${db}`);
    } finally {
      store.close();
    }
  } finally {
    release();
  }
}

try {
  await main();
} catch (err) {
  exitWithError(err);
}
