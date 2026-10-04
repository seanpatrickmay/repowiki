import { createHash } from "node:crypto";
import type { Manifest } from "@repowiki/core";
import { type LlmMessage, LlmOutputError, type Provider } from "@repowiki/llm";
import {
  buildFileGraph,
  type Cluster,
  type ClusterOptions,
  type ClusterSummary,
  clusterFiles,
  DEFAULT_CLUSTER_OPTIONS,
  DEFAULT_GRAPH_WEIGHTS,
  DEFAULT_SUMMARY_LIMITS,
  type FileGraph,
  type GraphWeights,
  summarizeClusters,
} from "../cluster/index.ts";
import type { RepoIndex } from "../index/index.ts";
import { estimateTokens, MANIFEST_REQUEST, manifestSystemPrompt, retryMessages } from "./prompt.ts";
import { ManifestProposal, proposalProblems } from "./proposal.ts";
import { proposalToManifest } from "./to-manifest.ts";

export interface ManifestBuildOptions {
  provider: Provider;
  repoName: string;
  /**
   * Use the Message Batches API (half price). Default true: no one waits on a build. Only an
   * unbatched build caches its prompt prefix.
   */
  batch?: boolean;
  /** Haiku 4.5 has a 200K context; the prompt must leave room for the answer. */
  maxPromptTokens?: number;
  graphWeights?: GraphWeights;
  clusterOptions?: ClusterOptions;
}

export interface ManifestBuild {
  manifest: Manifest;
  clusters: Cluster[];
  summaries: ClusterSummary[];
  /** Why the first answer was rejected, when it was; the second answer was then accepted. */
  rejected: string[];
  /** Estimated size of the cached prefix (instructions plus cluster digest). */
  promptTokens: number;
}

export class ManifestBuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export const DEFAULT_MAX_PROMPT_TOKENS = 150_000;
const MAX_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 16_000;

/**
 * The manifest call's cacheKey: the sha plus a hash of the prompt, so builds of one sha with
 * different options (weights, clustering, budget) never share a key. Without `system`, the
 * prefix that every key for this sha starts with, for matching ledger rows.
 */
export function manifestCacheKey(sha: string, system?: string): string {
  if (system === undefined) return `manifest-${sha}`;
  return `manifest-${sha}-${createHash("sha256").update(system).digest("hex").slice(0, 12)}`;
}

/** index → clusters → one LLM call (plus at most one retry) → a validated new manifest. */
export async function buildManifest(
  index: RepoIndex,
  options: ManifestBuildOptions,
): Promise<ManifestBuild> {
  if (index.files.length === 0)
    throw new ManifestBuildError(`${index.sha} has no files to document`);
  const graph = buildFileGraph(index, options.graphWeights ?? DEFAULT_GRAPH_WEIGHTS);
  const clusters = clusterFiles(graph, options.clusterOptions ?? DEFAULT_CLUSTER_OPTIONS);
  const maxPromptTokens = options.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;

  // Shrink the per-cluster listings until the prompt fits; the cluster count never changes.
  let limits = DEFAULT_SUMMARY_LIMITS;
  let summaries = summarizeClusters(index, graph, clusters, limits);
  let system = manifestSystemPrompt(options.repoName, index.sha, summaries);
  while (estimateTokens(system) > maxPromptTokens) {
    if (limits.files <= 1 && limits.symbols === 0) {
      throw new ManifestBuildError(
        `${clusters.length} clusters do not fit in ${maxPromptTokens} prompt tokens`,
      );
    }
    limits = {
      ...limits,
      files: Math.max(1, Math.floor(limits.files / 2)),
      symbols: Math.floor(limits.symbols / 2),
    };
    summaries = summarizeClusters(index, graph, clusters, limits);
    system = manifestSystemPrompt(options.repoName, index.sha, summaries);
  }

  // Cache the prefix only off the Batches API, where a retry follows within seconds. A batched
  // retry arrives long after the 5-minute TTL, so a batched cache write (1.25x input) is never
  // read. The retry reuses `system` and the cacheKey unchanged: the provider requires a cached
  // prefix to be byte-identical, and only the messages after it carry the rejection.
  const batch = options.batch ?? true;
  const cacheKey = batch ? undefined : manifestCacheKey(index.sha, system);
  let messages: LlmMessage[] = [{ role: "user", content: MANIFEST_REQUEST }];
  let rejected: string[] = [];
  for (let attempt = 1; ; attempt++) {
    let problems: string[];
    let answer: string;
    let outputError: LlmOutputError | undefined;
    try {
      const { output } = await options.provider.generate({
        purpose: "manifest",
        system,
        messages,
        schema: ManifestProposal,
        maxTokens: MAX_OUTPUT_TOKENS,
        ...(cacheKey === undefined ? {} : { cacheKey }),
        batch,
      });
      problems = proposalProblems(output, clusters);
      if (problems.length === 0) {
        return {
          manifest: toManifest(output, index, graph, clusters),
          clusters,
          summaries,
          rejected,
          promptTokens: estimateTokens(system),
        };
      }
      answer = JSON.stringify(output);
    } catch (error) {
      if (!(error instanceof LlmOutputError)) throw error;
      problems = [error.message];
      answer = error.text;
      outputError = error;
    }
    if (attempt === MAX_ATTEMPTS) {
      throw new ManifestBuildError(
        `the manifest answer was rejected twice. first answer: ${rejected.join("; ")}; retry: ${problems.join("; ")}`,
        outputError === undefined ? undefined : { cause: outputError },
      );
    }
    rejected = problems;
    messages = [{ role: "user", content: MANIFEST_REQUEST }, ...retryMessages(answer, problems)];
  }
}

/**
 * proposalToManifest throws on an answer proposalProblems should already have refused. That is a
 * bug in one of the two, not something the model can fix, so it is surfaced rather than retried.
 */
function toManifest(
  proposal: ManifestProposal,
  index: RepoIndex,
  graph: FileGraph,
  clusters: readonly Cluster[],
): Manifest {
  try {
    return proposalToManifest(proposal, index, graph, clusters);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ManifestBuildError(`an accepted manifest answer could not be applied: ${reason}`, {
      cause: error,
    });
  }
}
