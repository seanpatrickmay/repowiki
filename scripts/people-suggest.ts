import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { configuredEmail, openStore, readPeople, WikiBuildError } from "@repowiki/engine";
import { CliError } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import {
  loadPeopleFile,
  parseSuggestArgs,
  peopleFilePath,
  renderSuggest,
  SUGGEST_USAGE,
} from "./people-cli.ts";
import { acquireBuildLock, exitWithError, problemLine } from "./wiki-cli.ts";

/**
 * pnpm people:suggest <repo> [--out dir] [--people-file file] (spec v2 #6 §6 step 6, §10): who
 * RepoWiki thinks wrote the repository, how it joined their identities, and the merges it would
 * suggest, with masked emails. No LLM call and no write: the stored wiki is copied to a temporary
 * directory under the build lock and read there, so an older store's migration never touches it
 * (planner ruling). Never writes in <repo>.
 */
function main(): void {
  const args = parseSuggestArgs(process.argv.slice(2));
  const repo = resolve(args.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory())
    throw new CliError(`no such repository: ${args.repo}; ${SUGGEST_USAGE}`);
  const out = resolveOutDir(repo, args.out ?? join(homedir(), ".repowiki", basename(repo)));
  if (out === null)
    throw new CliError(
      "refusing an out dir inside the documented repository; choose --out elsewhere",
    );
  const config = loadPeopleFile(peopleFilePath(repo, out, args.peopleFile));
  const db = join(out, "wiki.db");
  if (!existsSync(db)) throw new WikiBuildError(`no wiki at ${db}; run pnpm wiki:build first`);
  const scratch = mkdtempSync(join(tmpdir(), "repowiki-suggest-"));
  try {
    const release = acquireBuildLock(out, (line) => console.error(line));
    try {
      for (const suffix of ["", "-wal", "-shm"])
        if (existsSync(`${db}${suffix}`))
          copyFileSync(`${db}${suffix}`, join(scratch, `wiki.db${suffix}`));
    } finally {
      release();
    }
    const store = openStore(join(scratch, "wiki.db"));
    try {
      const sha = store.getHead();
      if (sha === null)
        throw new WikiBuildError(`the wiki at ${db} has no head; run pnpm wiki:build first`);
      const read = readPeople({ repo, sha, store, config, ownerEmail: configuredEmail(repo) });
      for (const warning of read.warnings) console.error(problemLine(warning));
      console.log(renderSuggest(read, config));
    } finally {
      store.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  exitWithError(err);
}
