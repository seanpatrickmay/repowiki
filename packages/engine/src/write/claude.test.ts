import { fileURLToPath } from "node:url";
import { Revision } from "@repowiki/core";
import {
  cassetteFetch,
  cassetteMode,
  createClaudeProvider,
  createLedger,
  DEFAULT_MODELS,
} from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { writePages } from "./build.ts";
import { memoryWikipediaCache } from "./test-cache.ts";
import { testWiki } from "./test-wiki.ts";

const mode = cassetteMode();
const cassette = (name: string) =>
  fileURLToPath(new URL(`./__cassettes__/${name}.json`, import.meta.url));
/** Two live pages and maybe a retry each, unbatched; a replay is instant. */
const TIMEOUT_MS = mode === "record" ? 180_000 : undefined;

describe("writePages with Claude (cassette)", () => {
  it(
    "writes both of the sample wiki's pages from the recording, with no dropped claims",
    async () => {
      const ledger = createLedger();
      const provider = createClaudeProvider({
        models: DEFAULT_MODELS,
        ledger,
        runId: "test-run",
        run: { kind: "build", sha: testWiki().index.sha },
        apiKey: mode === "record" ? undefined : "cassette-replay",
        fetch: cassetteFetch(cassette("sample-pages"), mode),
        now: () => new Date("2026-10-01T12:00:00Z"),
      });
      const { pages } = await writePages(testWiki(), {
        provider,
        repoName: "sample",
        batch: false,
        wikipedia: {
          cache: memoryWikipediaCache(),
          fetch: cassetteFetch(cassette("sample-wikipedia"), mode),
        },
        now: () => new Date("2026-10-01T12:00:00Z"),
      });
      // The replay is deterministic, so both pages are written and nothing is dropped.
      expect(pages.map((p) => p.featureId).sort()).toEqual(["deliverables", "signals"]);
      expect(pages.every((p) => p.failure === null && p.dropped.length === 0)).toBe(true);
      const written = pages.flatMap((p) => (p.revision === null ? [] : [p.revision]));
      expect(written.length).toBe(2);
      for (const revision of written) expect(Revision.parse(revision)).toEqual(revision);
      const entries = ledger.entries();
      expect(entries.length).toBe(pages.reduce((n, p) => n + p.calls, 0));
      expect(entries.every((e) => e.purpose === "write" && !e.batch && e.runKind === "build")).toBe(
        true,
      );
      expect(entries.every((e) => e.sha === testWiki().index.sha)).toBe(true);
      expect(entries.every((e) => e.model.startsWith("claude-haiku-4-5"))).toBe(true);
    },
    TIMEOUT_MS,
  );
});
