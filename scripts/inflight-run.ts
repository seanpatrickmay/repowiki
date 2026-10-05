import { join } from "node:path";
import type { GitHubSnapshot } from "@repowiki/core";
import {
  buildExport,
  buildJournal,
  type Completed,
  completeInFlight,
  type Derived,
  deriveInFlight,
  ensureInflightRepo,
  estimateSummaries,
  type FetchOptions,
  fetchHeads,
  type GitHubSource,
  githubFetchUrl,
  type HeadState,
  headStates,
  INFLIGHT_DIR,
  removeInflightRepo,
  resolveGitHubIdentity,
  type Store,
  WikiBuildError,
  withinBudget,
  writeExport,
} from "@repowiki/engine";
import { createLedger, type ModelConfig, type Provider } from "@repowiki/llm";
import {
  fetchLine,
  type InflightArgs,
  inflightEstimateLine,
  readLine,
  suggestFor,
} from "./inflight-cli.ts";
import { CliError } from "./manifest-cli.ts";
import { lazyClaudeProvider, requireApiKey } from "./wiki-cli.ts";

/** What a refresh works on: the documented repository, its out dir and store, and the flags. */
export interface RefreshContext {
  repo: string;
  out: string;
  repoName: string;
  store: Store;
  args: InflightArgs;
  models: ModelConfig;
  log: (line: string) => void;
  now?: () => Date;
}

/** What the online half is read through: gh in the command; fakes and file remotes in tests. */
export interface RefreshSources {
  github: GitHubSource;
  /** Tests only: a fixture remote and the "file" protocol. The command fetches from github.com. */
  fetch?: { url: string; options: FetchOptions };
  /** Tests only: replaces Claude. */
  provider?: Provider;
}

export type RefreshResult =
  | { kind: "skipped"; reason: string }
  | { kind: "dry-run" }
  | ({ kind: "done"; exportPath: string } & Completed);

const exportOptions = (ctx: RefreshContext) => ({
  repo: ctx.repoName,
  exportedAt: (ctx.now ?? (() => new Date()))().toISOString(),
});

/** Steps 5-6 (spec v2 #9 §4.1): the impacts and the issue map, with page search over the export. */
function derive(
  ctx: RefreshContext,
  snapshot: GitHubSnapshot,
  heads: ReadonlyMap<number, HeadState>,
): Promise<Derived> {
  return deriveInFlight({
    store: ctx.store,
    dir: join(ctx.out, INFLIGHT_DIR),
    snapshot,
    heads,
    model: ctx.models.inflight,
    suggest: suggestFor(buildExport(ctx.store, exportOptions(ctx))),
    log: ctx.log,
  });
}

/**
 * Steps 7-8: the estimate (an unpriced model is a usage error before any call), the dry run's
 * stop, the key check when a call is due, the summary round under --max-usd, then the snapshot
 * stored and export.json and llms.txt rewritten. `provider` null makes no call.
 */
async function settle(
  ctx: RefreshContext,
  derived: Derived,
  provider: (() => Provider) | null,
): Promise<RefreshResult> {
  const { store, args, models } = ctx;
  const estimate = estimateSummaries(derived, models.inflight, args.batch);
  if (estimate === null)
    throw new CliError(`the inflight role's model ${models.inflight} has no known price`);
  ctx.log(inflightEstimateLine(estimate, args));
  if (args.dryRun) return { kind: "dry-run" };
  const asking =
    provider !== null &&
    withinBudget(derived, models.inflight, args.batch, args.maxUsd).chosen.length > 0;
  const completed = await completeInFlight(store, derived, {
    provider: asking ? provider() : null,
    model: models.inflight,
    batch: args.batch,
    maxUsd: args.maxUsd,
    fetchedAt: derived.snapshot.fetchedAt,
    previous: store.getInFlight(),
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
  });
  store.putInFlight(completed.inflight);
  const exportPath = join(ctx.out, "export.json");
  writeExport(store, exportPath, exportOptions(ctx));
  return { kind: "done", exportPath, ...completed };
}

/** The Claude provider for the summary round: one ledger run of kind "inflight" at the head. */
function claude(ctx: RefreshContext, wikiHead: string): () => Provider {
  return () => {
    // Calls are due: fail once, up front, rather than once per pull request.
    requireApiKey("wiki:inflight");
    const runId = `wiki-inflight-${wikiHead}-${new Date().toISOString()}`;
    return lazyClaudeProvider({
      command: "wiki:inflight",
      models: ctx.models,
      ledger: createLedger((entry) => ctx.store.appendLedger(entry)),
      runId,
      run: { kind: "inflight", sha: wikiHead },
      journal: buildJournal(ctx.store),
      deadlineMinutes: ctx.args.deadlineMinutes,
      log: ctx.log,
    });
  };
}

/**
 * pnpm wiki:inflight online (spec v2 #9 §4.1): resolve the identity and read GitHub (any skip
 * reason is returned and nothing is written, R3); store the snapshot (not on a dry run); fetch
 * every head into inflight.git; derive, rebuilding inflight.git once when it lost an object (R5);
 * then settle the summaries. The store must hold a wiki.
 */
export async function refreshOnline(
  ctx: RefreshContext,
  sources: RefreshSources,
): Promise<RefreshResult> {
  const head = ctx.store.getHead();
  if (head === null)
    throw new WikiBuildError("the store has no wiki yet; run pnpm wiki:build first");
  const resolved = resolveGitHubIdentity(ctx.repo, ctx.args.github);
  if ("skip" in resolved) return { kind: "skipped", reason: resolved.skip };
  const read = sources.github.read(resolved.identity);
  if ("skip" in read) return { kind: "skipped", reason: read.skip };
  const { snapshot } = read;
  ctx.log(readLine(snapshot));
  if (!ctx.args.dryRun) ctx.store.putGitHubSnapshot(snapshot);
  const url = sources.fetch?.url ?? githubFetchUrl(resolved.identity);
  const fetchAll = () => {
    const dir = ensureInflightRepo(ctx.out, ctx.repo);
    const fetched = fetchHeads(dir, url, snapshot.pulls, sources.fetch?.options);
    ctx.log(fetchLine(fetched.heads, fetched.problem));
    return fetched.heads;
  };
  let derived = await derive(ctx, snapshot, fetchAll());
  if (derived.corrupt) {
    ctx.log("inflight.git lost an object it borrowed; rebuilding it once");
    removeInflightRepo(join(ctx.out, INFLIGHT_DIR));
    derived = await derive(ctx, snapshot, fetchAll());
  }
  const noCall = ctx.args.noLlm;
  const provider = sources.provider;
  return settle(
    ctx,
    derived,
    noCall ? null : provider === undefined ? claude(ctx, derived.wikiHead) : () => provider,
  );
}

/**
 * The offline re-derive (spec v2 #9 §4.2): the stored snapshot, less the pull requests in `drop`
 * (merged by an update; they leave the stored snapshot too), the heads inflight.git holds now,
 * and summaries only from the cache or kept from the previous snapshot. No gh, no fetch, no call.
 * Skipped when GitHub was never read.
 */
export async function refreshOffline(
  ctx: RefreshContext,
  drop: ReadonlySet<number> = new Set(),
): Promise<RefreshResult> {
  const stored = ctx.store.getGitHubSnapshot();
  if (stored === null)
    return {
      kind: "skipped",
      reason: "GitHub was never read; run pnpm wiki:inflight online first",
    };
  const snapshot: GitHubSnapshot = {
    ...stored,
    pulls: stored.pulls.filter((p) => !drop.has(p.number)),
  };
  if (snapshot.pulls.length !== stored.pulls.length && !ctx.args.dryRun)
    ctx.store.putGitHubSnapshot(snapshot);
  const derived = await derive(
    ctx,
    snapshot,
    headStates(join(ctx.out, INFLIGHT_DIR), snapshot.pulls),
  );
  if (derived.corrupt)
    ctx.log("inflight.git lost an object; the next online pnpm wiki:inflight rebuilds it");
  return settle(ctx, derived, null);
}

/** --clear: the stored snapshot, the summary cache and inflight.git removed, the export rewritten. */
export function clearInFlightData(ctx: RefreshContext): string {
  ctx.store.clearInFlight();
  ctx.store.pruneInFlightSummaries([]);
  removeInflightRepo(join(ctx.out, INFLIGHT_DIR));
  const exportPath = join(ctx.out, "export.json");
  writeExport(ctx.store, exportPath, exportOptions(ctx));
  return exportPath;
}
