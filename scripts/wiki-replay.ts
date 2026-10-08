import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseMemberId } from "@repowiki/core";
import {
  architectureSystemPrompt,
  diffCommits,
  isAncestor,
  openStore,
  type ReplayStep,
  reachableCommits,
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
import { beforeUpdate, inflightAfterUpdate } from "./inflight-hook.ts";
import { CliError, exitCodeFor, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { peopleAfterUpdate } from "./people-hook.ts";
import {
  invariantsHold,
  newestBuildTokens,
  parseStepRecords,
  projectStep,
  renderProjection,
  renderReplaySummary,
  renderStepRecords,
  type StepRecord,
  type StoppedAt,
  tokensOf,
} from "./replay-cli.ts";
import {
  estimateLine,
  parseReplayArgs,
  type ReplayArgs,
  renderUpdateSummary,
} from "./update-cli.ts";
import { articleDueAsStored, estimateFor, needsKey, readInput, runUpdate } from "./update-run.ts";
import {
  acquireBuildLock,
  describeError,
  exitWithError,
  problemLine,
  requireApiKey,
  writeFileAtomic,
} from "./wiki-cli.ts";
import { checkStoredAt, checkWiki } from "./wiki-problems.ts";

/**
 * pnpm wiki:replay <repo> <from> <to> [--limit N]: moves the wiki stored for <repo> through the
 * first-parent merges (and squash-merged pull requests) between <from> and <to> (spec §6.2), one
 * wiki:update per step, so each page's history is dated by the merges that changed it. The wiki must be built at <from> (or be
 * part-way along, from an earlier replay: it resumes from its head). --limit N replays the next N
 * steps only; --dry-run lists them with an upper-side estimate. After every step it records
 * spec §8's invariants in replay-<from7>-<to7>.md, rendered from the step records saved beside it
 * (replay-<from7>-<to7>.json), so a resumed run keeps every earlier run's rows; the summary says
 * where a run stopped. Every step stored but never recorded (by a killed run, or moved to by
 * wiki:update) is checked and recorded on resume, and the records of the steps the wiki's head
 * descends from are kept even when the head is between two steps. Exits 1 when any step's
 * invariant failed. Holds the out dir's lock while it runs.
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

/** The records saved by earlier runs of this replay, or none when there is no file. */
function loadRecords(path: string): StepRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    return parseStepRecords(text);
  } catch (err) {
    const why = err instanceof Error ? err.message : "unreadable";
    throw new WikiBuildError(`${path} is ${why}; delete it to start the record again`);
  }
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
  // The steps still to do from the wiki's head, and the whole list from `from` that numbers them.
  const steps = replaySteps(repo, head, args.to);
  const full = replaySteps(repo, args.from, args.to);
  const todo = args.limit === null ? steps : steps.slice(0, args.limit);
  const left = steps.length - todo.length;
  if (args.dryRun) {
    if (todo.length === 0) {
      console.error(`the wiki is already at ${head}; nothing to replay`);
      return;
    }
    dryRun(store, args, repo, todo, left, models);
    return;
  }

  const base = join(out, `replay-${args.from.slice(0, 7)}-${args.to.slice(0, 7)}`);
  const summaryPath = `${base}.md`;
  const recordsPath = `${base}.json`;
  const positionOf = (sha: string): number => full.findIndex((step) => step.sha === sha) + 1;
  // The steps the wiki has moved through: its head and the steps it descends from, whether or
  // not the head is a step itself (a wiki:update may have moved it between two).
  const reached = reachableCommits(repo, head);
  const passed = new Set(full.filter((step) => reached.has(step.sha)).map((step) => step.sha));
  // Their records (an earlier run's, or a run before a kill), by position. A wiki back at `from`
  // starts the record again.
  const records = loadRecords(recordsPath)
    .filter((r) => passed.has(r.step.sha))
    .map((r) => ({ ...r, position: positionOf(r.step.sha) }))
    .sort((a, b) => a.position - b.position);
  const buildTokens = newestBuildTokens(store.listLedger());
  const log = (line: string) => console.error(line);
  let done = 0;
  const save = (stopped: StoppedAt | null) => {
    writeFileAtomic(recordsPath, renderStepRecords(records));
    writeFileAtomic(
      summaryPath,
      renderReplaySummary(
        repoName,
        args.from,
        args.to,
        records,
        steps.length - done,
        buildTokens,
        stopped,
      ),
    );
  };
  // A run killed after it stored a step but before it recorded it (or a wiki:update that moved the
  // wiki to a step) left a stored step with no record: check each now (no call) and record it, so
  // no step goes unchecked. The head's step is checked as a step's wiki is; an earlier one by what
  // it stored, since its pages may have changed since.
  let recovered = false;
  for (const [index, step] of full.entries()) {
    if (!passed.has(step.sha) || records.some((r) => r.step.sha === step.sha)) continue;
    if (store.getManifest(step.sha) === null) continue;
    const short = step.sha.slice(0, 7);
    log(`${short}: stored by a run that stopped before recording it; checking it now`);
    const used = totalsOf(
      store.listLedger().filter((e) => e.runKind === "update" && e.sha === step.sha),
    );
    const history = readHistory(repo, step.sha);
    const problems =
      step.sha === head
        ? (await checkWiki(store, repo, history)).problems
        : await checkStoredAt(store, repo, step.sha, history);
    for (const problem of problems) log(problemLine(`${short}: ${problem}`));
    records.push({
      step,
      position: index + 1,
      recovered: true,
      stored: 0,
      carried: 0,
      staleClaims: 0,
      tokens: tokensOf(used.tokens),
      usd: used.usd,
      problems: problems.length,
      failures: [],
      refused: [],
      architectureSkipped: null,
    });
    recovered = true;
  }
  records.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const exportPath = join(out, "export.json");
  const writeExports = () =>
    writeExport(store, exportPath, { repo: repoName, exportedAt: new Date().toISOString() });
  if (recovered) {
    save(null);
    writeExports();
  }
  if (todo.length === 0) {
    console.error(`the wiki is already at ${head}; nothing to replay`);
    if (!invariantsHold(records, buildTokens)) process.exitCode = 1;
    return;
  }

  const before = beforeUpdate(store);
  for (const [i, step] of todo.entries()) {
    try {
      const input = await readInput(repo, step.sha);
      const estimate = estimateFor(store, input, args, models, repoName);
      log(
        `[${i + 1}/${todo.length}] ${step.sha.slice(0, 7)}: ${estimateLine(estimate, args.batch)}`,
      );
      // Calls are certain, so fail once here rather than once per page, and before the step
      // commits anything; a step that makes none (nothing cited changed, no article due) needs no
      // key.
      if (needsKey(estimate)) requireApiKey("wiki:replay");
      const { update, runId, articleError } = await runUpdate(
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
      const check = await checkWiki(store, repo, readHistory(repo, step.sha));
      // Problem lines quote model-derived ids and paths: one printable line each.
      for (const problem of check.problems) log(problemLine(`${step.sha.slice(0, 7)}: ${problem}`));
      records.push({
        step,
        position: positionOf(step.sha) || records.length + 1,
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
      done++;
      save(null);
      // The step is stored and recorded; its article's failure still stops the run.
      if (articleError !== null) throw articleError;
    } catch (err) {
      // Say where the run stopped and why, so the record is never read as a finished replay; the
      // original error still ends the run.
      try {
        save({
          position: positionOf(step.sha) || records.length + 1,
          sha: step.sha,
          reason: describeError(err, false),
        });
      } catch {
        // The stop is already being reported by the original error.
      }
      // The steps this run stored are in the store: the export must not stay behind them.
      if (done > 0 || store.getHead() !== head) {
        try {
          writeExports();
        } catch {
          // The stop is already being reported by the original error.
        }
      }
      throw err;
    }
  }
  // The work in flight follows the head the replay reached, once, offline (R4, C14).
  if (before !== null) {
    const lines = await inflightAfterUpdate(
      { repo, out, repoName, store, models, log },
      before,
      store.getHead() ?? head,
      true,
    );
    for (const line of lines)
      if (line !== "" && !line.startsWith("#")) log(`work in flight: ${line}`);
  }
  // People, once, at the head the replay reached (R24): never per step.
  const people = await peopleAfterUpdate({
    repo,
    out,
    repoName,
    store,
    models,
    log,
    command: "wiki:replay",
    batch: args.batch,
    maxUsd: args.peopleMaxUsd,
  });
  for (const line of people) if (line !== "" && !line.startsWith("#")) log(`people: ${line}`);
  writeExports();
  console.log(renderReplaySummary(repoName, args.from, args.to, records, left, buildTokens));
  console.log(`Wrote ${exportPath} and ${summaryPath}; store: ${join(out, "wiki.db")}`);
  if (!invariantsHold(records, buildTokens)) process.exitCode = 1;
}

/** The dry run's table: each step's diff and an upper-side estimate, from the store as it stands. */
function dryRun(
  store: Store,
  args: ReplayArgs,
  repo: string,
  todo: readonly ReplayStep[],
  left: number,
  models: ReturnType<typeof loadModels>,
): void {
  const repoName = basename(repo);
  const head = store.getHead() ?? args.from;
  const manifest = store.getLatestManifest();
  const prompts =
    manifest === null
      ? { update: "", article: "" }
      : {
          update: updateSystemPrompt(repoName, manifest),
          article: architectureSystemPrompt(repoName, manifest),
        };
  let previous = head;
  // Only the first step can find the article already due; after it, the article is a call of
  // whichever step writes it, which the projection counts for a step that touches a page.
  const dueNow = manifest !== null && articleDueAsStored(store, manifest);
  const projections = todo.map((step, i) => {
    const changes = diffCommits(repo, previous, step.sha);
    previous = step.sha;
    const paths = changes.flatMap((c) =>
      [c.oldPath, c.newPath].filter((p): p is string => p !== null),
    );
    return projectStep(
      {
        step,
        files: changes.length,
        pages: touchedPages(store, paths),
        articleDue: i === 0 && dueNow,
        addsFiles: changes.some((c) => c.status === "added"),
      },
      prompts,
      args.budgetTokens,
      models.write,
      args.batch,
    );
  });
  console.log(renderProjection(projections, left));
}

try {
  await main();
} catch (err) {
  exitWithError(err);
}
