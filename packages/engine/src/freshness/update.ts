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
  type ArchitectureOutcome,
  assembleUpdate,
  type BuildJournal,
  carriedHistory,
  checkTitles,
  type PageRewrite,
  type RewriteOutcome,
  rewritePages,
  storeArticle,
  type WrittenPages,
  writeArchitecture,
  writePages,
} from "../write/index.ts";
import { type ArticleDue, articleDue, articleSkipped } from "./article.ts";
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
  /**
   * Whole pages that could not be written (not stored; the update went on), sorted by feature. A
   * manifest-change one stays pending in the store, so the next update writes it whole again.
   */
  failures: { featureId: string; failure: string }[];
  /** Dirty pages whose rewrite stored nothing, with the assembler's reason, sorted by feature. */
  refused: { featureId: string; why: string }[];
  /** Why the project's article was rewritten, or null when it carried forward. */
  articleDue: ArticleDue | null;
  /** Why it carried forward: "too few pages" for an article, or "current"; null when rewritten. */
  architectureSkipped: "too few pages" | "current" | null;
  /** The article's round, or null when it carried forward. */
  architecture: ArchitectureOutcome | null;
}

/**
 * The update stored its pages and moved the head, then its About article round threw: `update`
 * says what was stored (its `architecture` is null), and `cause` is what the round threw.
 */
export class UpdateArticleError extends UpdateError {
  readonly update: WikiUpdate;
  constructor(update: WikiUpdate, cause: unknown) {
    const why = cause instanceof Error ? cause.message : typeof cause;
    super(`the update to ${update.to} is stored, but its About article could not be: ${why}`, {
      cause,
    });
    this.update = update;
  }
}

/**
 * Moves the wiki from its head to index.sha (spec §6.1). planUpdate reads the diff and places
 * the new files with no call; the tie-break model settles the disputed ones; one constrained
 * manifest call runs if a feature drifted. Then one round of update calls for the dirty pages,
 * batched together with whole-page writes for the features the operations changed and the
 * active features with no page yet, and one retry round. Only pages that changed get a revision
 * (`reason: "update"`, or `"manifest-change"` for a page written whole after the operations),
 * with the PR the new commit merged; every other page carries forward. The manifest at index.sha
 * (marked as the new drift baseline when an LLM revised it), the revisions and the head are
 * stored in one transaction, which also flushes `journal`. Only a call or batch that failed
 * (`callFailed`, after the SDK's retries) stops the update before anything is stored (spec §6.3):
 * a whole page the model's answers could not give is left out and listed in `failures`, and its
 * journal rows are forgotten with the others.
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
  const { rewrites, whole, pending, carried, pages } = planPages(
    plan,
    store,
    input,
    manifest,
    affected,
  );
  const changedBefore = new Set(pending);

  const wikipedia: WikipediaOptions = {
    cache: {
      get: (title) => store.getWikipediaSummary(title),
      put: (title, summary, at) => store.putWikipediaSummary(title, summary, at),
    },
    ...(options.wikipediaFetch === undefined ? {} : { fetch: options.wikipediaFetch }),
    now,
  };
  // A whole page carries its own History and that of every page merged into it, transitively.
  const carry = new Map(
    whole.map((id) => {
      const own = pages.get(id) ?? null;
      return [id, carriedHistory(manifest, id, own, (f) => pages.get(f) ?? null, history)];
    }),
  );
  const budget = options.budgetTokens === undefined ? {} : { budgetTokens: options.budgetTokens };
  // Both rounds issue their first calls in this tick, so they share one Message Batch.
  const [written, rewritten] = await Promise.all([
    whole.length === 0
      ? null
      : writePages(
          { index, manifest, sources, history, graph: plan.graph, only: whole, carry },
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
    ...outcomes.filter((o) => o.callFailed).map((o) => `${o.featureId}: ${o.failure}`),
    ...(written?.pages ?? [])
      .filter((p) => p.callFailed)
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
  const refused: { featureId: string; why: string }[] = [];
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
      refused.push({ featureId: outcome.featureId, why: assembled.why });
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
  const failures: { featureId: string; failure: string }[] = [];
  for (const page of written?.pages ?? []) {
    if (page.revision === null) {
      // Not stored, and not an abort: only a failed call stops the update. Its journal rows are
      // forgotten with the rest, so a rerun does not replay the same answers.
      const failure = page.failure ?? "the page could not be written";
      log(`${page.featureId}: not stored: ${failure}`);
      failures.push({ featureId: page.featureId, failure });
      continue;
    }
    const parent = pages.get(page.featureId);
    const reason =
      affected.has(page.featureId) || changedBefore.has(page.featureId) || parent !== undefined
        ? "manifest-change"
        : "build";
    stored.push({ ...page.revision, parentId: parent?.id ?? null, reason, pr: plan.pr });
  }
  stored.sort((a, b) => (a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0));

  const revised = drift?.revised === true;
  store.transaction(() => {
    store.putManifest(manifest, { llmRevised: revised });
    for (const revision of stored) store.putRevision(revision);
    // A manifest-change page that could not be written is written whole by the next update too.
    store.setPendingWhole(
      failures.map((f) => f.featureId).filter((id) => affected.has(id) || changedBefore.has(id)),
    );
    store.setHead(plan.to);
    options.journal?.flush();
  });

  // The project's article, in its own round once the pages are stored: a failed article is
  // reported and never undoes them (as in buildWiki).
  const active = manifest.features.filter((f) => f.status.kind === "active");
  const current = active.flatMap((f) => store.getCurrentRevision(f.id) ?? []);
  const article = store.getCurrentArchitecture();
  const due = articleDue(article, current, manifest, (id) => store.getRevision(id));
  let architecture: ArchitectureOutcome | null = null;
  const result = (): WikiUpdate => ({
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
    failures: failures.sort((a, b) =>
      a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0,
    ),
    refused: refused.sort((a, b) =>
      a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0,
    ),
    articleDue: due,
    architectureSkipped: articleSkipped(due, current.length),
    architecture,
  });
  if (due !== null) {
    log(`architecture: rewritten: ${due}`);
    try {
      architecture = await writeArchitecture(
        {
          index,
          manifest,
          sources,
          history,
          pages: current,
          parent: article,
          number: store.countArchitectureRevisions() + 1,
          reason: article === null ? "build" : "update",
          pr: plan.pr,
        },
        { provider: options.provider, repoName: options.repoName, batch, wikipedia, now, log },
      );
      storeArticle(store, architecture, options.journal);
    } catch (error) {
      // The pages and the head are already stored: the caller must still see what was.
      architecture = null;
      throw new UpdateArticleError(result(), error);
    }
  }
  return result();
}
