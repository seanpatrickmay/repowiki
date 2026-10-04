import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseMemberId } from "@repowiki/core";
import {
  architectureSystemPrompt,
  diffCommits,
  isAncestor,
  openStore,
  readHistory,
  replaySteps,
  resolveCommit,
  type Store,
  StoreError,
  UpdateError,
  updateSystemPrompt,
  WikiBuildError,
  writeExport,
} from "@repowiki/engine";
import { totalsOf } from "@repowiki/llm";
import { CliError, exitCodeFor, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import {
  newestBuildTokens,
  projectStep,
  renderProjection,
  renderReplaySummary,
  type StepRecord,
  tokensOf,
} from "./replay-cli.ts";
import {
  estimateLine,
  parseReplayArgs,
  type ReplayArgs,
  renderUpdateSummary,
} from "./update-cli.ts";
import { estimateFor, readInput, runUpdate } from "./update-run.ts";
import {
  acquireBuildLock,
  describeError,
  problemLine,
  requireApiKey,
  writeFileAtomic,
} from "./wiki-cli.ts";
import { checkWiki } from "./wiki-problems.ts";

/**
 * pnpm wiki:replay <repo> <from> <to> [--limit N]: moves the wiki stored for <repo> through the
 * first-parent merges between <from> and <to> (spec §6.2), one wiki:update per merge, so each
 * page's history is dated by the merges that changed it. The wiki must be built at <from> (or be
 * part-way along, from an earlier replay: it resumes from its head). --limit N replays the next N
 * steps only; --dry-run lists them with an upper-side estimate. After every step it records
 * spec §8's invariants in replay-<from7>-<to7>.md. Holds the out dir's lock while it runs.
 */
async function main(): Promise<void> {
  const args = parseReplayArgs(process.argv.slice(2));
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
  const from = resolveCommit(repo, args.from);
  const to = resolveCommit(repo, args.to);
  const release = args.dryRun ? () => {} : acquireBuildLock(out, (line) => console.error(line));
  try {
    const store = openStore(db);
    try {
      await replay(store, { ...args, from, to }, repo, out, models);
    } finally {
      store.close();
    }
  } finally {
    release();
  }
}

/** Active features with a member file among `paths` in the store's latest manifest. */
function touchedPages(store: Store, paths: readonly string[]): number {
  const manifest = store.getLatestManifest();
  if (manifest === null) return 0;
  const changed = new Set(paths);
  const active = new Set(
    manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id),
  );
  const touched = new Set<string>();
  for (const [member, entry] of Object.entries(manifest.membership)) {
    const path = parseMemberId(member)?.path;
    if (path !== undefined && changed.has(path) && active.has(entry.featureId)) {
      touched.add(entry.featureId);
    }
  }
  return touched.size;
}

async function replay(
  store: Store,
  args: ReplayArgs,
  repo: string,
  out: string,
  models: ReturnType<typeof loadModels>,
): Promise<void> {
  const repoName = basename(repo);
  const head = store.getHead();
  if (head === null) throw new WikiBuildError("the store has no wiki yet; run wiki:build first");
  const onTheWay =
    head === args.from || (isAncestor(repo, args.from, head) && isAncestor(repo, head, args.to));
  if (!onTheWay) {
    throw new WikiBuildError(
      `the wiki is at ${head}, which is not on the way from ${args.from} to ${args.to}`,
    );
  }
  const steps = replaySteps(repo, head, args.to);
  const todo = args.limit === null ? steps : steps.slice(0, args.limit);
  const left = steps.length - todo.length;
  if (todo.length === 0) {
    console.error(`the wiki is already at ${head}; nothing to replay`);
    return;
  }
  if (args.dryRun) {
    const manifest = store.getLatestManifest();
    const prompts =
      manifest === null
        ? { update: "", article: "" }
        : {
            update: updateSystemPrompt(repoName, manifest),
            article: architectureSystemPrompt(repoName, manifest),
          };
    let previous = head;
    const projections = todo.map((step) => {
      const changes = diffCommits(repo, previous, step.sha);
      previous = step.sha;
      const paths = changes.flatMap((c) =>
        [c.oldPath, c.newPath].filter((p): p is string => p !== null),
      );
      return projectStep(
        { step, files: changes.length, pages: touchedPages(store, paths) },
        prompts,
        args.budgetTokens,
        models.write,
        args.batch,
      );
    });
    console.log(renderProjection(projections, left));
    return;
  }

  const buildTokens = newestBuildTokens(store.listLedger());
  const records: StepRecord[] = [];
  const summaryPath = join(out, `replay-${args.from.slice(0, 7)}-${args.to.slice(0, 7)}.md`);
  const log = (line: string) => console.error(line);
  for (const [i, step] of todo.entries()) {
    const input = await readInput(repo, step.sha);
    const estimate = estimateFor(store, input, args, models, repoName);
    log(`[${i + 1}/${todo.length}] ${step.sha.slice(0, 7)}: ${estimateLine(estimate, args.batch)}`);
    // Calls are certain, so fail once here rather than once per page; a step that makes none
    // (nothing cited changed) needs no key.
    if (estimate.rewrites + estimate.whole + estimate.small > 0) requireApiKey("wiki:replay");
    const { update, runId } = await runUpdate(
      store,
      input,
      args,
      models,
      repoName,
      log,
      "wiki:replay",
    );
    const totals = totalsOf(store.listLedger(runId));
    writeFileAtomic(
      join(out, `update-${step.sha.slice(0, 7)}.md`),
      renderUpdateSummary(repoName, update, estimate, totals),
    );
    const check = checkWiki(store, repo, readHistory(repo, step.sha));
    // Problem lines quote model-derived ids and paths: one printable line each.
    for (const problem of check.problems) log(problemLine(`${step.sha.slice(0, 7)}: ${problem}`));
    records.push({
      step,
      stored: update.stored.length,
      carried: update.carried.length,
      staleClaims: update.staleClaims,
      tokens: tokensOf(totals.tokens),
      usd: totals.usd,
      problems: check.problems.length,
      failures: update.failures,
      refused: update.refused,
      architectureSkipped: update.architectureSkipped,
    });
    writeFileAtomic(
      summaryPath,
      renderReplaySummary(
        repoName,
        args.from,
        args.to,
        records,
        steps.length - records.length,
        buildTokens,
      ),
    );
  }
  const exportPath = join(out, "export.json");
  writeExport(store, exportPath, { repo: repoName, exportedAt: new Date().toISOString() });
  console.log(renderReplaySummary(repoName, args.from, args.to, records, left, buildTokens));
  console.log(`Wrote ${exportPath} and ${summaryPath}; store: ${join(out, "wiki.db")}`);
}

try {
  await main();
} catch (err) {
  const known = err instanceof UpdateError || err instanceof WikiBuildError;
  const code = known || err instanceof StoreError ? 1 : exitCodeFor(err);
  if (code === null) throw err;
  // The flag is read raw: a usage error must still print, verbose or not.
  console.error(describeError(err, process.argv.includes("--verbose")));
  process.exit(code);
}
