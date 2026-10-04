import { fileURLToPath } from "node:url";
import { Manifest } from "@repowiki/core";
import {
  cassetteFetch,
  cassetteMode,
  createClaudeProvider,
  createLedger,
  DEFAULT_MODELS,
} from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { buildManifest } from "./build.ts";
import { sampleIndex } from "./test-index.ts";

const mode = cassetteMode();
const CASSETTE = fileURLToPath(new URL("./__cassettes__/sample-manifest.json", import.meta.url));

describe("buildManifest with Claude (cassette)", () => {
  it("turns the sample index into a valid manifest in one or two calls", async () => {
    const ledger = createLedger();
    const provider = createClaudeProvider({
      models: DEFAULT_MODELS,
      ledger,
      runId: "test-run",
      apiKey: mode === "record" ? undefined : "cassette-replay",
      fetch: cassetteFetch(CASSETTE, mode),
      now: () => new Date("2026-10-01T12:00:00Z"),
    });
    const index = sampleIndex();
    const build = await buildManifest(index, {
      provider,
      repoName: "sample",
      batch: false,
      clusterOptions: { resolution: 1, minClusterSize: 1 },
    });
    expect(Manifest.parse(build.manifest)).toEqual(build.manifest);
    expect(Object.keys(build.manifest.membership)).toHaveLength(13);
    expect(build.manifest.features.length).toBeGreaterThanOrEqual(1);
    expect(ledger.entries().length).toBe(build.rejected.length === 0 ? 1 : 2);
    expect(ledger.entries().every((e) => e.purpose === "manifest" && !e.batch)).toBe(true);
  });
});
