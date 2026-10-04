import type { Claim, Manifest, Revision } from "@repowiki/core";
import type { FetchLike, Provider } from "@repowiki/llm";
import type { ClusterOptions } from "../cluster/index.ts";
import {
  codeAliases,
  featureNeighbours,
  type WikipediaOptions,
  wikipediaTitlesIn,
} from "../link/index.ts";
import { addAliases, type Store } from "../store/index.ts";
import {
  assembleUpdate,
  type BuildJournal,
  checkTitles,
  type PageRewrite,
  type RewriteOutcome,
  rewritePages,
  type WrittenPages,
  writePages,
} from "../write/index.ts";
import { DEFAULT_DRIFT_THRESHOLD } from "./drift.ts";
import { type DriftOutcome, reviseManifest } from "./drift-call.ts";
import {
  knownFeature,
  measureDrift,
  planPages,
  planUpdate,
  UpdateError,
  type UpdateInput,
} from "./plan.ts";
import { breakTies, type TieBreak } from "./tiebreak.ts";

export interface UpdateOptions {
  provider: Provider;
  repoName: string;
  /** The batch journal, flushed in the transaction that stores the update. */
  journal?: BuildJournal;
  /** Default true: nothing waits on an update. */
  batch?: boolean;
  /** Pack budget for update and whole-page calls (default 30,000). */
  budgetTokens?: number;
  /** Drift above this share asks for manifest operations (default 0.20, spec §6.1 step 4). */
  driftThreshold?: number;
  clusterOptions?: ClusterOptions;
  wikipediaFetch?: FetchLike;
  now?: () => Date;
  log?: (line: string) => void;
}

/** What one update did (spec §6.1). */
export interface WikiUpdate {
  from: string;
  to: string;
  /** The PR the new commit merged, or null. */
  pr: number | null;
  /** Commits new since `from`. */
  commits: number;
  /** Files that differ between the two commits. */
  changes: number;
  /** The manifest stored at `to`, and whether an LLM revised it (the new drift baseline). */
  manifest: Manifest;
  revised: boolean;
  tieBreak: TieBreak;
  /** The drift call, or null when no feature drifted. */
  drift: DriftOutcome | null;
  /** The update calls' answers, one per dirty page. */
  rewrites: RewriteOutcome[];
  /** Pages written whole: changed by the manifest's operations, or never written. */
  written: WrittenPages | null;
  /** The revisions stored, sorted by feature. */
  stored: Revision[];
  /** Active features whose page carried forward unchanged, sorted. */
  carried: string[];
  /** Claims this update marked out of date. */
  staleClaims: number;
}

/** Only a call that failed, never a page the model could not support, stops an update. */
const callFailed = (failure: string | null): boolean =>
  failure !== null && /^the (write|update) call failed/.test(failure);

/**
 * Moves the wiki from its head to index.sha (spec §6.1). planUpdate reads the diff and places
 * the new files with no call; the tie-break model settles the disputed ones; one constrained
 * manifest call runs if a feature drifted. Then one round of update calls for the dirty pages,
 * batched together with whole-page writes for the features the operations changed and the
 * active features with no page yet, and one retry round. Only pages that changed get a revision
 * (`reason: "update"`, or `"manifest-change"` for a page written whole after the operations),
 * with the PR the new commit merged; every other page carries forward. The manifest at index.sha
 * (marked as the new drift baseline when an LLM revised it), the revisions and the head are
 * stored in one transaction, which also flushes `journal`. A call that fails stops the update
 * before anything is stored (spec §6.3).
 */
export async function updateWiki(
  store: Store,
  input: UpdateInput,
  options: UpdateOptions,
): Promise<WikiUpdate> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const batch = options.batch ?? true;
  const { index, sources, history } = input;
  const plan = planUpdate(store, input, now);
  const tieBreak = await breakTies(
    {
      disputed: plan.placement.disputed,
      manifest: plan.previous,
      graph: plan.graph,
      featureOf: knownFeature(plan),
    },
    { provider: options.provider, batch, log },
  );
  const placed = new Map([...plan.placement.decided, ...tieBreak.placed]);
  const measured = measureDrift(
    plan,
    index,
    placed,
    options.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD,
  );
  const drift =
    measured.drifted.length === 0
      ? null
      : await reviseManifest(
          {
            repoName: options.repoName,
            manifest: measured.manifest,
            index,
            graph: plan.graph,
            churn: measured.churn,
            drifted: measured.drifted,
            newFiles: new Set(placed.keys()),
          },
          {
            provider: options.provider,
            batch,
            log,
            ...(options.clusterOptions === undefined
              ? {}
              : { clusterOptions: options.clusterOptions }),
          },
        );
  const revisedManifest = drift?.manifest ?? measured.manifest;
  const manifest = addAliases(revisedManifest, codeAliases(revisedManifest, sources));
  const affected = new Set(drift?.affected ?? []);
  const { rewrites, whole, carried, pages } = planPages(plan, store, input, manifest, affected);

  const wikipedia: WikipediaOptions = {
    cache: {
      get: (title) => store.getWikipediaSummary(title),
      put: (title, summary, at) => store.putWikipediaSummary(title, summary, at),
    },
    ...(options.wikipediaFetch === undefined ? {} : { fetch: options.wikipediaFetch }),
    now,
  };
  const budget = options.budgetTokens === undefined ? {} : { budgetTokens: options.budgetTokens };
  // Both rounds issue their first calls in this tick, so they share one Message Batch.
  const [written, rewritten] = await Promise.all([
    whole.length === 0
      ? null
      : writePages(
          { index, manifest, sources, history, graph: plan.graph, only: whole },
          {
            provider: options.provider,
            repoName: options.repoName,
            batch,
            wikipedia,
            now,
            log,
            ...budget,
          },
        ),
    rewrites.length === 0
      ? null
      : rewritePages(
          { rewrites, index, manifest, sources, history },
          { provider: options.provider, repoName: options.repoName, batch, log, ...budget },
        ),
  ]);
  const outcomes = rewritten?.outcomes ?? [];
  const failed = [
    ...outcomes.filter((o) => callFailed(o.failure)).map((o) => `${o.featureId}: ${o.failure}`),
    ...(written?.pages ?? [])
      .filter((p) => callFailed(p.failure))
      .map((p) => `${p.featureId}: ${p.failure}`),
  ];
  if (failed.length > 0)
    throw new UpdateError(`the update stopped before storing anything: ${failed.join("; ")}`);

  // Every claim of the pages being assembled is linked; their Wikipedia titles are checked once.
  const rewriteOf = new Map(rewrites.map((r) => [r.featureId, r]));
  const titles = outcomes.flatMap((o) => {
    const claims: Claim[] = [
      ...(rewriteOf.get(o.featureId)?.claims.map((c) => c.claim) ?? []),
      ...o.replaced.values(),
      ...o.added.map((a) => a.claim),
    ];
    return claims.flatMap((c) => wikipediaTitlesIn(c.text));
  });
  const links =
    outcomes.length === 0
      ? new Map<string, string | null>()
      : (await checkTitles(titles, wikipedia, log)).links;
  const neighbours = featureNeighbours(plan.graph, manifest);
  const stored: Revision[] = [];
  const kept = [...carried];
  let staleClaims = 0;
  for (const outcome of outcomes) {
    const assembled = assembleUpdate({
      rewrite: rewriteOf.get(outcome.featureId) as PageRewrite,
      outcome,
      index,
      manifest,
      history,
      commitDate: plan.commitDate,
      generatedAt: now().toISOString(),
      pr: plan.pr,
      reason: "update",
      neighbours,
      wikipedia: links,
    });
    if (assembled.revision === null) {
      if (assembled.why !== "nothing changed")
        log(`${outcome.featureId}: not updated: ${assembled.why}`);
      kept.push(outcome.featureId);
      continue;
    }
    for (const problem of assembled.diagramProblems)
      log(`${outcome.featureId}: diagram refused: ${problem}`);
    staleClaims += assembled.revision.sections.reduce(
      (n, s) => n + s.claims.filter((c) => c.staleSince === plan.to).length,
      0,
    );
    stored.push(assembled.revision);
  }
  for (const page of written?.pages ?? []) {
    if (page.revision === null) continue;
    const parent = pages.get(page.featureId);
    const reason =
      affected.has(page.featureId) || parent !== undefined ? "manifest-change" : "build";
    stored.push({ ...page.revision, parentId: parent?.id ?? null, reason, pr: plan.pr });
  }
  stored.sort((a, b) => (a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0));

  const revised = drift?.revised === true;
  store.transaction(() => {
    store.putManifest(manifest, { llmRevised: revised });
    for (const revision of stored) store.putRevision(revision);
    store.setHead(plan.to);
    options.journal?.flush();
  });
  return {
    from: plan.from,
    to: plan.to,
    pr: plan.pr,
    commits: plan.commits.length,
    changes: plan.changes.length,
    manifest,
    revised,
    tieBreak,
    drift,
    rewrites: outcomes,
    written,
    stored,
    carried: kept.sort(),
    staleClaims,
  };
}
