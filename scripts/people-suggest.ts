import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { openStore, readPeople, WikiBuildError } from "@repowiki/engine";
import { CliError } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import {
  ownerEmailOf,
  parseSuggestArgs,
  peopleConfigFor,
  renderSuggest,
  SUGGEST_USAGE,
  storeCopy,
} from "./people-cli.ts";
import { exitWithError, printPeopleSafely, problemLine } from "./wiki-cli.ts";

/**
 * pnpm people:suggest <repo> [--out dir] [--people-file file] (spec v2 #6 §6 step 6, §10): who
 * RepoWiki thinks wrote the repository, how it joined their identities, and the merges it would
 * suggest, with masked emails. No LLM call and no write: the stored wiki is copied to a temporary
 * directory under the build lock and read there, so an older store's migration never touches it
 * (planner ruling). Never writes in <repo>.
 */
function main(): void {
  // People's own commands always print scrubbed of addresses (the Task 28 ruling).
  printPeopleSafely(true);
  const args = parseSuggestArgs(process.argv.slice(2));
  const repo = resolve(args.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory())
    throw new CliError(`no such repository: ${args.repo}; ${SUGGEST_USAGE}`);
  const out = resolveOutDir(repo, args.out ?? join(homedir(), ".repowiki", basename(repo)));
  if (out === null)
    throw new CliError(
      "refusing an out dir inside the documented repository; choose --out elsewhere",
    );
  const db = join(out, "wiki.db");
  if (!existsSync(db)) throw new WikiBuildError(`no wiki at ${db}; run pnpm wiki:build first`);
  const copy = storeCopy(out);
  try {
    const store = openStore(copy.path);
    try {
      const sha = store.getHead();
      if (sha === null)
        throw new WikiBuildError(`the wiki at ${db} has no head; run pnpm wiki:build first`);
      // --people-file, else the path wiki:people remembered (the C1 ruling).
      const { config } = peopleConfigFor(store, repo, out, args.peopleFile, false);
      const ownerEmail = ownerEmailOf(repo, (line) => console.error(line));
      const read = readPeople({ repo, sha, store, config, ownerEmail });
      for (const warning of read.warnings) console.error(problemLine(warning));
      console.log(renderSuggest(read, config));
    } finally {
      store.close();
    }
  } finally {
    copy.remove();
  }
}

try {
  main();
} catch (err) {
  exitWithError(err);
}
