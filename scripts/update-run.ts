import {
  addAliases,
  architectureSystemPrompt,
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
import {
  createClaudeProvider,
  createLedger,
  LlmError,
  type ModelConfig,
  type Provider,
} from "@repowiki/llm";
import { estimateUpdate, type UpdateEstimate } from "./update-cli.ts";
import { KEYLESS_MESSAGE, type RunFlags } from "./wiki-cli.ts";

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

/**
 * What moving the store's wiki to input.index.sha would cost, from the plan the update makes
 * before its calls: the dirty pages' update packs, the whole pages of features with none, one
 * tie-break call if a new file is disputed, one drift call if a feature drifted, and the About
 * article if a page may change. Refuses (UpdateError) as the update would.
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
      article:
        pages.rewrites.length + pages.whole.length > 0
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
 * Moves the store's wiki to input.index.sha with live calls: one ledger run of kind "update" at
 * that sha, and the store's batch journal, so a killed update's batches are collected by the
 * next run instead of paid for again. The Claude provider is built on the first call, so an
 * update that needs none (nothing cited changed) needs no API key.
 */
export async function runUpdate(
  store: Store,
  input: UpdateInput,
  flags: RunFlags,
  models: ModelConfig,
  repoName: string,
  log: (line: string) => void,
): Promise<{ update: WikiUpdate; runId: string }> {
  const sha = input.index.sha;
  const runId = `wiki-update-${sha}-${new Date().toISOString()}`;
  const ledger = createLedger((entry) => store.appendLedger(entry));
  const journal = buildJournal(store);
  let claude: Provider | undefined;
  const provider: Provider = {
    generate: (request) => {
      if (claude === undefined && !process.env.ANTHROPIC_API_KEY) {
        throw new LlmError(KEYLESS_MESSAGE);
      }
      claude ??= createClaudeProvider({
        models,
        ledger,
        runId,
        run: { kind: "update", sha },
        batchJournal: journal,
        onBatchRequest: journal.tag,
        ...(flags.deadlineMinutes === null
          ? {}
          : { batchDeadlineMs: flags.deadlineMinutes * 60_000 }),
        onBatchCreated: (b) => log(`batch ${b.id} created (${b.requests} requests)`),
        onBatchProgress: (p) =>
          log(`batch ${p.id}: ${p.status} (${p.processing} processing, ${p.succeeded} done)`),
      });
      return claude.generate(request);
    },
  };
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
