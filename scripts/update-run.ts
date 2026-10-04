import type { Manifest } from "@repowiki/core";
import {
  addAliases,
  architectureSystemPrompt,
  articleDue,
  buildFileGraph,
  buildJournal,
  buildPack,
  buildUpdatePack,
  codeAliases,
  DEFAULT_ARCHITECTURE_BUDGET_TOKENS,
  DEFAULT_DRIFT_THRESHOLD,
  DEFAULT_MAX_FILE_BYTES,
  featureNeighbours,
  indexRepo,
  measureDrift,
  planPages,
  planUpdate,
  readHistory,
  readSources,
  type Store,
  type UpdateInput,
  updateSystemPrompt,
  updateWiki,
  type WikiUpdate,
  writeSystemPrompt,
} from "@repowiki/engine";
import { createLedger, type ModelConfig } from "@repowiki/llm";
import { estimateUpdate, type UpdateEstimate } from "./update-cli.ts";
import { type LiveCommand, lazyClaudeProvider, type RunFlags } from "./wiki-cli.ts";

/** The repository read at `sha`, as an update takes it. No call. */
export async function readInput(repo: string, sha: string): Promise<UpdateInput> {
  const index = await indexRepo(repo, sha);
  return {
    repo,
    index,
    sources: readSources(repo, index.sha, DEFAULT_MAX_FILE_BYTES),
    history: readHistory(repo, index.sha),
    graph: buildFileGraph(index),
  };
}

/** Whether the About article is due as the store stands against `manifest`, with no page changed. */
export function articleDueAsStored(store: Store, manifest: Manifest): boolean {
  const stored = manifest.features.flatMap((f) =>
    f.status.kind === "active" ? (store.getCurrentRevision(f.id) ?? []) : [],
  );
  return (
    articleDue(store.getCurrentArchitecture(), stored, manifest, (id) => store.getRevision(id)) !==
    null
  );
}

/**
 * What moving the store's wiki to input.index.sha would cost, from the plan the update makes
 * before its calls: the dirty pages' update packs, the whole pages of features with none, one
 * tie-break call if a new file is disputed, one drift call if a feature drifted, and the About
 * article if a page may change or it is due as the store stands. Refuses (UpdateError) as the
 * update would.
 */
export function estimateFor(
  store: Store,
  input: UpdateInput,
  flags: RunFlags,
  models: ModelConfig,
  repoName: string,
): UpdateEstimate {
  const { index, sources, history } = input;
  const plan = planUpdate(store, input);
  const measured = measureDrift(plan, index, plan.placement.decided, DEFAULT_DRIFT_THRESHOLD);
  const manifest = addAliases(measured.manifest, codeAliases(measured.manifest, sources));
  const pages = planPages(plan, store, input, manifest, new Set());
  const neighbours = featureNeighbours(plan.graph, manifest);
  const budgetTokens = flags.budgetTokens;
  // The article is rewritten when a page may change (its lead may), and also when it is due as
  // the store stands: none yet, or one that no longer matches the pages and the manifest.
  const dueNow = articleDueAsStored(store, manifest);
  const articleMayBeDue = pages.rewrites.length + pages.whole.length > 0 || dueNow;
  return estimateUpdate(
    {
      rewrites: pages.rewrites.map((rewrite) =>
        buildUpdatePack({ rewrite, manifest, index, sources, budgetTokens }),
      ),
      updateSystem: updateSystemPrompt(repoName, manifest),
      whole: pages.whole.map((featureId) =>
        buildPack({
          featureId,
          manifest,
          index,
          sources,
          history,
          neighbours: neighbours.get(featureId) ?? new Map(),
          budgetTokens,
        }),
      ),
      writeSystem: writeSystemPrompt(repoName, manifest),
      disputed: plan.placement.disputed.length > 0,
      drifted: measured.drifted.length > 0,
      article: articleMayBeDue
        ? {
            system: architectureSystemPrompt(repoName, manifest),
            budgetTokens: DEFAULT_ARCHITECTURE_BUDGET_TOKENS,
          }
        : null,
    },
    models,
    flags.batch,
  );
}

/**
 * Whether the update the estimate describes makes a call, so it needs the API key: any page or
 * small call, or the About article (a due article is a call even when no page is dirty). The
 * commands check this before the update, which commits a step's pages and head first.
 */
export const needsKey = (estimate: UpdateEstimate): boolean =>
  estimate.rewrites + estimate.whole + estimate.small > 0 || estimate.articleUsd !== null;

/**
 * Moves the store's wiki to input.index.sha with live calls: one ledger run of kind "update" at
 * that sha, and the store's batch journal, so a killed update's batches are collected by the
 * next run instead of paid for again. The Claude provider is built on the first call, so an
 * update that needs none (nothing cited changed) needs no API key; with none set, the keyless
 * error names `command`.
 */
export async function runUpdate(
  store: Store,
  input: UpdateInput,
  flags: RunFlags,
  models: ModelConfig,
  repoName: string,
  log: (line: string) => void,
  command: LiveCommand = "wiki:update",
): Promise<{ update: WikiUpdate; runId: string }> {
  const sha = input.index.sha;
  const runId = `wiki-update-${sha}-${new Date().toISOString()}`;
  const ledger = createLedger((entry) => store.appendLedger(entry));
  const journal = buildJournal(store);
  const provider = lazyClaudeProvider({
    command,
    models,
    ledger,
    runId,
    run: { kind: "update", sha },
    journal,
    deadlineMinutes: flags.deadlineMinutes,
    log,
  });
  const update = await updateWiki(store, input, {
    provider,
    journal,
    repoName,
    batch: flags.batch,
    budgetTokens: flags.budgetTokens,
    log,
  });
  return { update, runId };
}
