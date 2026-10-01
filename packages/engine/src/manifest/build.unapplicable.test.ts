import { describe, expect, it, vi } from "vitest";
import { buildManifest, ManifestBuildError } from "./build.ts";
import { sampleIndex } from "./test-index.ts";
import { SAMPLE_CLUSTER_OPTIONS, SAMPLE_PROPOSAL, scriptedProvider } from "./test-provider.ts";

const APPLY_ERROR = new Error("3 indexed files belong to no assigned cluster: a.ts");
vi.mock("./to-manifest.ts", () => ({
  proposalToManifest: () => {
    throw APPLY_ERROR;
  },
}));

describe("buildManifest when an accepted answer cannot be applied", () => {
  it("surfaces proposalToManifest's error as a ManifestBuildError, without retrying", async () => {
    const { provider, requests } = scriptedProvider(SAMPLE_PROPOSAL, SAMPLE_PROPOSAL);
    const build = buildManifest(sampleIndex(), {
      provider,
      repoName: "sample",
      clusterOptions: SAMPLE_CLUSTER_OPTIONS,
    });
    await expect(build).rejects.toThrow(ManifestBuildError);
    await expect(build).rejects.toThrow(/could not be applied: 3 indexed files belong to no/);
    await expect(build).rejects.toMatchObject({ cause: APPLY_ERROR });
    expect(requests).toHaveLength(1);
  });
});
