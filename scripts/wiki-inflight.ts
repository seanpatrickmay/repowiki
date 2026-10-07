import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { LLMS_TXT_FILE } from "@repowiki/core";
import { ghSource, openStore, WikiBuildError } from "@repowiki/engine";
import {
  INFLIGHT_USAGE,
  parseInflightArgs,
  renderInflightTable,
  spendLine,
} from "./inflight-cli.ts";
import {
  clearInFlightData,
  type RefreshContext,
  refreshOffline,
  refreshOnline,
} from "./inflight-run.ts";
import { CliError, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { acquireBuildLock, exitWithError, problemLine } from "./wiki-cli.ts";

/**
 * pnpm wiki:inflight <repo>: reads the repository's open pull requests and issues through the
 * owner's gh, fetches their heads into <out>/inflight.git, predicts what each would change in
 * the wiki, summarizes the new ones in one batch under --max-usd, and rewrites export.json and
 * llms.txt (spec v2 #9 §4.1, §6.1). Without GitHub it skips, exit 0, and changes nothing (R3).
 * Holds the out dir's build lock; writes only wiki.db, inflight.git, export.json and llms.txt,
 * and never writes in <repo>.
 */
async function main(): Promise<void> {
  const args = parseInflightArgs(process.argv.slice(2));
  const repo = resolve(args.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new CliError(`no such repository: ${args.repo}; ${INFLIGHT_USAGE}`);
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
  const log = (line: string) => console.error(line);
  const release = acquireBuildLock(out, log);
  try {
    const store = openStore(db);
    try {
      const ctx: RefreshContext = { repo, out, repoName, store, args, models, log };
      if (args.clear) {
        const exportPath = clearInFlightData(ctx);
        console.log(
          `Cleared the work in flight; wrote ${exportPath} and ${join(out, LLMS_TXT_FILE)}`,
        );
        return;
      }
      const result = args.offline
        ? await refreshOffline(ctx)
        : await refreshOnline(ctx, { github: ghSource() });
      if (result.kind === "skipped") {
        console.log(`work in flight skipped: ${problemLine(result.reason)}`);
        return;
      }
      if (result.kind === "dry-run") return;
      console.log(renderInflightTable(result.inflight, result.status, result.failures));
      const fresh = [...result.status.values()].filter((status) => status === "new").length;
      console.log(spendLine(fresh, result.spent));
      console.log(`Wrote ${result.exportPath} and ${join(out, LLMS_TXT_FILE)}; store: ${db}`);
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
