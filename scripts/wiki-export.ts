import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { LLMS_TXT_FILE } from "@repowiki/core";
import { openStore, WikiBuildError, writeExport } from "@repowiki/engine";
import { CliError } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { acquireBuildLock, exitWithError } from "./wiki-cli.ts";

const USAGE = "usage: pnpm wiki:export <repo-path> [--out dir]";

/**
 * pnpm wiki:export <repo> [--out dir]: writes export.json and llms.txt next to wiki.db from the
 * stored wiki (spec §3 `export`), with no LLM call, for a wiki built before llms.txt existed.
 * wiki:build, wiki:update and wiki:replay write both themselves. Holds the out dir's build lock
 * and never writes in <repo>.
 */
function main(): void {
  const [repoArg, flag, outArg, ...extra] = process.argv.slice(2);
  const outFlag = flag === undefined || (flag === "--out" && outArg !== undefined && outArg !== "");
  if (repoArg === undefined || repoArg === "" || !outFlag || extra.length > 0) {
    throw new CliError(USAGE);
  }
  const repo = resolve(repoArg);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new CliError(`no such repository: ${repoArg}; ${USAGE}`);
  }
  const repoName = basename(repo);
  const out = resolveOutDir(repo, outArg ?? join(homedir(), ".repowiki", repoName));
  if (out === null) {
    throw new CliError(
      "refusing to write inside the documented repository; choose an --out path elsewhere",
    );
  }
  const db = join(out, "wiki.db");
  if (!existsSync(db)) throw new WikiBuildError(`no wiki at ${db}; run pnpm wiki:build first`);
  const release = acquireBuildLock(out, (line) => console.error(line));
  try {
    const store = openStore(db);
    try {
      const exportPath = join(out, "export.json");
      writeExport(store, exportPath, { repo: repoName, exportedAt: new Date().toISOString() });
      console.log(`Wrote ${exportPath} and ${join(out, LLMS_TXT_FILE)}`);
    } finally {
      store.close();
    }
  } finally {
    release();
  }
}

try {
  main();
} catch (err) {
  exitWithError(err);
}
