import { fileURLToPath } from "node:url";
import { Architecture } from "@repowiki/core";
import {
  cassetteFetch,
  cassetteMode,
  createClaudeProvider,
  createLedger,
  DEFAULT_MODELS,
} from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { writeArchitecture } from "./architecture.ts";
import { testArchitectureInput } from "./test-architecture.ts";
import { memoryWikipediaCache } from "./test-cache.ts";

const mode = cassetteMode();
const cassette = (name: string) =>
  fileURLToPath(new URL(`./__cassettes__/${name}.json`, import.meta.url));
/** One live call and maybe a retry, unbatched; a replay is instant. */
const TIMEOUT_MS = mode === "record" ? 180_000 : undefined;
const now = () => new Date("2026-10-02T12:00:00Z");

describe("writeArchitecture with Claude (cassette)", () => {
  it(
    "writes the sample project's own article from the recording",
    async () => {
      const input = testArchitectureInput();
      const ledger = createLedger();
      const provider = createClaudeProvider({
        models: DEFAULT_MODELS,
        ledger,
        runId: "test-run",
        run: { kind: "build", sha: input.index.sha },
        apiKey: mode === "record" ? undefined : "cassette-replay",
        fetch: cassetteFetch(cassette("sample-architecture"), mode),
        now,
      });
      const outcome = await writeArchitecture(
        { ...input, parent: null, number: 1 },
        {
          provider,
          repoName: "sample",
          batch: false,
          wikipedia: {
            cache: memoryWikipediaCache(),
            fetch: cassetteFetch(cassette("sample-architecture-wikipedia"), mode),
          },
          now,
        },
      );
      // The replay is deterministic, so the article is written.
      expect(outcome.failure).toBeNull();
      const article = outcome.architecture as Architecture;
      expect(Architecture.parse(article)).toEqual(article);
      // The title is the README's first heading, never the model's.
      expect(article.title).toBe("Sample Ops");
      expect(article.sections[0]?.key).toBe("lead");
      expect(article.sections.map((s) => s.key)).toContain("purpose");
      expect(article.edges).toEqual([
        { from: "deliverables", to: "signals", imports: 1, calls: 1 },
      ]);
      expect(article.basis).toEqual(["deliverables-aaaaaaaaaaaa", "signals-aaaaaaaaaaaa"]);
      const entries = ledger.entries();
      expect(entries).toHaveLength(outcome.calls);
      for (const e of entries) {
        expect(e).toMatchObject({
          purpose: "write",
          batch: false,
          cacheKey: null,
          featureId: null,
          runKind: "build",
          sha: input.index.sha,
        });
        expect(e.model.startsWith("claude-haiku-4-5")).toBe(true);
      }
    },
    TIMEOUT_MS,
  );
});
