import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  openStore,
  resolveCommit,
  StoreError,
  UpdateError,
  WikiBuildError,
} from "@repowiki/engine";
import { CliError, exitCodeFor, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { estimateLine, parseUpdateArgs } from "./update-cli.ts";
import { estimateFor, needsKey, readInput, runUpdate, writeUpdateOutputs } from "./update-run.ts";
import { acquireBuildLock, exitWithError, requireApiKey } from "./wiki-cli.ts";

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
      const ran = await runUpdate(store, input, args, models, repoName, log);
      // An article that failed after the update was stored still gets the export and summary.
      const { summary, exportPath, summaryPath } = writeUpdateOutputs(
        store,
        out,
        repoName,
        ran,
        estimate,
      );
      console.log(summary);
      console.log(`Wrote ${exportPath} and ${summaryPath}; store: ${db}`);
      if (ran.articleError !== null) throw ran.articleError;
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
