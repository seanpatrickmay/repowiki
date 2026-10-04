import { fileURLToPath } from "node:url";
import { Claim } from "@repowiki/core";
import {
  cassetteFetch,
  cassetteMode,
  createClaudeProvider,
  createLedger,
  DEFAULT_MODELS,
} from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { rewritePages } from "./rewrite.ts";
import { signalsRewrite } from "./test-update.ts";
import { testWiki } from "./test-wiki.ts";

const mode = cassetteMode();
const cassette = (name: string) =>
  fileURLToPath(new URL(`./__cassettes__/${name}.json`, import.meta.url));
/** One live call and maybe a retry, unbatched; a replay is instant. */
const TIMEOUT_MS = mode === "record" ? 180_000 : undefined;
const now = () => new Date("2026-10-03T12:00:00Z");

describe("rewritePages with Claude (cassette)", () => {
  it(
    "rewrites the sample page's stale claims from the recording",
    async () => {
      const wiki = testWiki();
      const ledger = createLedger();
      const provider = createClaudeProvider({
        models: DEFAULT_MODELS,
        ledger,
        runId: "test-run",
        run: { kind: "update", sha: wiki.index.sha },
        apiKey: mode === "record" ? undefined : "cassette-replay",
        fetch: cassetteFetch(cassette("sample-update"), mode),
        now,
      });
      const { outcomes, cacheKey } = await rewritePages(
        { rewrites: [signalsRewrite()], ...wiki },
        { provider, repoName: "sample", batch: false },
      );
      const [outcome] = outcomes;
      // The replay is deterministic: the call answered, and every stale claim was either
      // rewritten so it verifies or kept stale; none is dropped on an update.
      expect(outcome?.failure).toBeNull();
      const stale = signalsRewrite()
        .claims.filter((c) => c.status === "stale")
        .map((c) => c.claim.id)
        .sort();
      expect([...(outcome?.replaced.keys() ?? []), ...(outcome?.keptStale ?? [])].sort()).toEqual(
        stale,
      );
      for (const claim of outcome?.replaced.values() ?? [])
        expect(Claim.parse(claim)).toEqual(claim);
      // One page: no cached prefix to share.
      expect(cacheKey).toBeNull();
      const entries = ledger.entries();
      expect(entries).toHaveLength(outcome?.calls ?? 0);
      for (const e of entries) {
        expect(e).toMatchObject({
          purpose: "write",
          batch: false,
          cacheKey: null,
          featureId: "signals",
          runKind: "update",
          sha: wiki.index.sha,
        });
        expect(e.model.startsWith("claude-haiku-4-5")).toBe(true);
      }
    },
    TIMEOUT_MS,
  );
});
