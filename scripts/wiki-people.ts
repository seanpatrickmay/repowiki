import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type PeopleConfig, parseMatchKey } from "@repowiki/core";
import {
  buildJournal,
  configuredEmail,
  openStore,
  readPeople,
  type Store,
  saltedKey,
  writeExport,
} from "@repowiki/engine";
import { createLedger, type ModelConfig, totalsOf } from "@repowiki/llm";
import { CliError, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import {
  loadPeopleFile,
  PEOPLE_USAGE,
  type PeopleArgs,
  parsePeopleArgs,
  peopleFilePath,
  peopleTable,
  renderPeopleSummary,
  storeCopy,
  WIKI_PEOPLE_RUN_PREFIX,
} from "./people-cli.ts";
import { runPeopleStep } from "./people-run.ts";
import { acquireBuildLock, exitWithError, lazyClaudeProvider, requireApiKey } from "./wiki-cli.ts";

/**
 * pnpm wiki:people <repo> … (spec v2 #6 §10): turns People on for a built wiki and refreshes it at
 * the store's head: facts with no call, then the due narratives in one batched round under
 * --max-usd. --dry-run works on a copy of the store; --disable deletes the snapshot; --forget
 * deletes a person's narratives and registry row. Writes export.json and llms.txt once, and
 * people-<sha7>.md. Never writes in <repo>.
 */
async function main(): Promise<void> {
  const args = parsePeopleArgs(process.argv.slice(2));
  const repo = resolve(args.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory())
    throw new CliError(`no such repository: ${args.repo}; ${PEOPLE_USAGE}`);
  const out = resolveOutDir(repo, args.out ?? join(homedir(), ".repowiki", basename(repo)));
  if (out === null)
    throw new CliError(
      "refusing to write inside the documented repository; choose an --out path elsewhere",
    );
  const db = join(out, "wiki.db");
  if (!existsSync(db)) throw new CliError(`no wiki at ${db}; run pnpm wiki:build first`);
  const models = loadModels(args.config);
  const config = loadPeopleFile(peopleFilePath(repo, out, args.peopleFile));
  if (args.dryRun) {
    const copy = storeCopy(out);
    try {
      await withStore(copy.path, (store) => people(args, repo, out, store, config, models));
    } finally {
      copy.remove();
    }
    return;
  }
  const release = acquireBuildLock(out, (line) => console.error(line));
  try {
    await withStore(db, async (store) => {
      if (args.disable) return disable(repo, out, store);
      if (args.forget !== null) return forget(args.forget, repo, out, store, config);
      return people(args, repo, out, store, config, models);
    });
  } finally {
    release();
  }
}

async function withStore(path: string, fn: (store: Store) => Promise<void> | void): Promise<void> {
  const store = openStore(path);
  try {
    if (store.getHead() === null || store.getLatestManifest() === null)
      throw new CliError("the wiki has no head or manifest; run pnpm wiki:build first");
    await fn(store);
  } finally {
    store.close();
  }
}

const exportTo = (store: Store, out: string, repo: string): string => {
  const path = join(out, "export.json");
  writeExport(store, path, { repo: basename(repo), exportedAt: new Date().toISOString() });
  return path;
};

/** --disable (R24): the snapshot goes, so the export carries no People; ids and narratives stay. */
function disable(repo: string, out: string, store: Store): void {
  store.clearPeopleSnapshot();
  const path = exportTo(store, out, repo);
  console.log(
    `People is off for this wiki; wrote ${path}. Run pnpm wiki:people again to turn it on.`,
  );
}

/**
 * --forget <match-key> (spec v2 #6 §9): every person the key names, now or in the registry, loses
 * their narratives and registry row. It prints counts only: an excluded person's id is never shown.
 */
function forget(key: string, repo: string, out: string, store: Store, config: PeopleConfig): void {
  const parsed = parseMatchKey(key);
  if (parsed === null) throw new CliError(PEOPLE_USAGE);
  const salted = saltedKey(store.getPeopleSalt(), `${parsed.kind}:${parsed.value}`);
  const sha = store.getHead() as string;
  const read = readPeople({ repo, sha, store, config, ownerEmail: configuredEmail(repo) });
  const ids = new Set<string>();
  read.identities.groups.forEach((g, i) => {
    if (g.keys.includes(salted)) ids.add(read.assigned.ids[i] as string);
  });
  for (const row of store.listPeopleRegistry()) if (row.keys.includes(salted)) ids.add(row.id);
  let revisions = 0;
  store.transaction(() => {
    for (const id of ids) revisions += store.forgetPerson(id);
  });
  const path = exportTo(store, out, repo);
  console.log(
    `Forgot ${ids.size} ${ids.size === 1 ? "person" : "people"} (${revisions} narrative revisions); wrote ${path}.`,
  );
}

/** The People run itself: refresh, the capped narrative round, the export and the summary. */
async function people(
  args: PeopleArgs,
  repo: string,
  out: string,
  store: Store,
  config: PeopleConfig,
  models: ModelConfig,
): Promise<void> {
  const repoName = basename(repo);
  const sha = store.getHead() as string;
  const runId = `${WIKI_PEOPLE_RUN_PREFIX}${sha}-${new Date().toISOString()}`;
  const ledger = createLedger((entry) => store.appendLedger(entry));
  const log = (line: string) => console.error(line);
  const step = await runPeopleStep({
    repo,
    repoName,
    store,
    config,
    ownerEmail: configuredEmail(repo),
    narrative: args.narrative,
    only: args.only.length === 0 ? null : new Set(args.only),
    rebuildBlame: args.rebuildBlame,
    models,
    batch: args.batch,
    maxUsd: args.maxUsd,
    dryRun: args.dryRun,
    connect: () => {
      // A missing key fails here, once, before any call (M6 ruling).
      requireApiKey("wiki:people");
      const journal = buildJournal(store);
      const provider = lazyClaudeProvider({
        command: "wiki:people",
        models,
        ledger,
        runId,
        run: { kind: "people", sha },
        journal,
        deadlineMinutes: null,
        log,
      });
      return { provider, journal };
    },
    log,
  });
  for (const id of args.only)
    if (!step.rows.some((r) => r.id === id && r.kind === "human"))
      log(`--only ${id}: no person with a page has that id`);
  if (args.dryRun) {
    console.log(peopleTable(step.rows).join("\n"));
    return;
  }
  const path = exportTo(store, out, repo);
  const summary = renderPeopleSummary(
    repoName,
    sha,
    step.rows,
    step.notes,
    totalsOf(store.listLedger(runId)),
    step.taken.length > 0 ? step.estimateUsd : null,
  );
  const summaryPath = join(out, `people-${sha.slice(0, 7)}.md`);
  writeFileSync(summaryPath, summary);
  console.log(summary);
  console.log(`Wrote ${path} and ${summaryPath}; store: ${join(out, "wiki.db")}`);
}

try {
  await main();
} catch (err) {
  exitWithError(err);
}
