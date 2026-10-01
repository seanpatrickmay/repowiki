import { LlmError, LlmOutputError, type Provider } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { buildManifest, ManifestBuildError } from "./build.ts";
import type { ManifestProposal } from "./proposal.ts";
import { sampleIndex } from "./test-index.ts";
import { SAMPLE_CLUSTER_OPTIONS, SAMPLE_PROPOSAL, scriptedProvider } from "./test-provider.ts";

const GOOD = SAMPLE_PROPOSAL;
const MISSING_C03: ManifestProposal = { ...GOOD, clusters: GOOD.clusters.slice(0, 2) };
const options = (provider: Provider) => ({
  provider,
  repoName: "sample",
  clusterOptions: SAMPLE_CLUSTER_OPTIONS,
});

describe("buildManifest", () => {
  it("makes one batched, cached manifest call over the cluster digest", async () => {
    const { provider, requests } = scriptedProvider(GOOD);
    const build = await buildManifest(sampleIndex(), options(provider));
    expect(build.manifest.features.map((f) => f.id)).toEqual(["http-api", "web-frontend"]);
    expect(build.rejected).toEqual([]);
    expect(build.clusters.map((c) => c.id)).toEqual(["c01", "c02", "c03"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      purpose: "manifest",
      batch: true,
      cacheKey: `manifest-${"c".repeat(40)}`,
      messages: [{ role: "user", content: "Group these clusters into the wiki's feature pages." }],
    });
    expect(requests[0]?.system).toContain(`# Repository sample at ${"c".repeat(40)}: 3 clusters`);
    expect(requests[0]?.system).toContain("## c03: 2 files, 2 symbols (tsx 1, typescript 1)");
    expect(requests[0]?.system).toContain(
      "symbols: web/src/api.ts#fetchJson, web/src/main.tsx#Main",
    );
  });

  it("can make the call without the Batches API", async () => {
    const { provider, requests } = scriptedProvider(GOOD);
    await buildManifest(sampleIndex(), { ...options(provider), batch: false });
    expect(requests[0]?.batch).toBe(false);
  });

  it("retries once with the reasons, keeping the cached prefix", async () => {
    const { provider, requests } = scriptedProvider(MISSING_C03, GOOD);
    const build = await buildManifest(sampleIndex(), options(provider));
    expect(build.rejected).toEqual(['cluster "c03" is not assigned']);
    expect(requests[1]?.system).toBe(requests[0]?.system);
    expect(requests[1]?.cacheKey).toBe(requests[0]?.cacheKey);
    expect(requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[1]?.messages[2]?.content).toContain('- cluster "c03" is not assigned');
  });

  it("retries an answer that failed the output schema, quoting the raw text", async () => {
    const bad = new LlmOutputError("model output is not JSON", "oops");
    const { provider, requests } = scriptedProvider(bad, GOOD);
    await buildManifest(sampleIndex(), options(provider));
    expect(requests[1]?.messages[1]).toEqual({ role: "assistant", content: "oops" });
  });

  it("gives up after a second rejection, reporting both rounds' problems", async () => {
    const missingC02: ManifestProposal = {
      ...GOOD,
      clusters: GOOD.clusters.filter((c) => c.cluster !== "c02"),
    };
    const { provider, requests } = scriptedProvider(MISSING_C03, missingC02);
    const failure = buildManifest(sampleIndex(), options(provider));
    await expect(failure).rejects.toThrow(ManifestBuildError);
    await expect(failure).rejects.toThrow(
      'first answer: cluster "c03" is not assigned; retry: cluster "c02" is not assigned',
    );
    await expect(failure).rejects.not.toHaveProperty("cause");
    expect(requests).toHaveLength(2);
  });

  it("gives up after two unusable answers, keeping the second error as the cause", async () => {
    const first = new LlmOutputError("first answer is not JSON", "oops");
    const second = new LlmOutputError("second answer is not JSON", "again");
    const { provider } = scriptedProvider(first, second);
    const failure = buildManifest(sampleIndex(), options(provider));
    await expect(failure).rejects.toThrow(ManifestBuildError);
    await expect(failure).rejects.toThrow(
      "first answer: first answer is not JSON; retry: second answer is not JSON",
    );
    await expect(failure).rejects.toMatchObject({ cause: second });
  });

  it("does not retry provider failures; the SDK already retried them", async () => {
    const { provider, requests } = scriptedProvider(new LlmError("overloaded"), GOOD);
    await expect(buildManifest(sampleIndex(), options(provider))).rejects.toThrow("overloaded");
    expect(requests).toHaveLength(1);
  });

  it("shrinks the listings to fit the prompt budget, and refuses when nothing fits", async () => {
    const full = await buildManifest(sampleIndex(), options(scriptedProvider(GOOD).provider));
    const { provider, requests } = scriptedProvider(GOOD);
    await buildManifest(sampleIndex(), {
      ...options(provider),
      maxPromptTokens: full.promptTokens - 10,
    });
    expect(requests[0]?.system).not.toContain("web/src/main.tsx#Main");
    const tiny = { ...options(scriptedProvider(GOOD).provider), maxPromptTokens: 100 };
    await expect(buildManifest(sampleIndex(), tiny)).rejects.toThrow(/do not fit/);
  });

  it("halves the listings only as far as the budget needs, never dropping them outright", async () => {
    const full = await buildManifest(sampleIndex(), options(scriptedProvider(GOOD).provider));
    const { provider, requests } = scriptedProvider(GOOD);
    const budget = full.promptTokens - 10;
    const build = await buildManifest(sampleIndex(), {
      ...options(provider),
      maxPromptTokens: budget,
    });
    expect(build.promptTokens).toBeLessThanOrEqual(budget);
    expect(build.promptTokens).toBeLessThan(full.promptTokens);
    // Halving 25 -> 12 -> 6 -> 3 -> 1 is enough: each cluster keeps its first symbol.
    expect(requests[0]?.system).toContain("symbols: web/src/api.ts#fetchJson");
  });

  it("refuses a commit with no files", async () => {
    const empty = { ...sampleIndex(), files: [], imports: [], unresolved: [] };
    const { provider, requests } = scriptedProvider(GOOD);
    await expect(buildManifest(empty, options(provider))).rejects.toThrow(/no files/);
    expect(requests).toHaveLength(0);
  });
});
