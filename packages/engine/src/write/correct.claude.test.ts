import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, WikiExport } from "@repowiki/core";
import {
  bodyClaim,
  codeCitation,
  leadClaim,
  makeManifest,
  makeRevision,
} from "@repowiki/core/test-fixtures";
import {
  cassetteFetch,
  cassetteMode,
  createClaudeProvider,
  createLedger,
  DEFAULT_MODELS,
} from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { correctClaims } from "./correct.ts";
import { testVerifyContext } from "./test-wiki.ts";

const mode = cassetteMode();
const cassette = (name: string) =>
  fileURLToPath(new URL(`./__cassettes__/${name}.json`, import.meta.url));
/** One live call and maybe a retry, unbatched; a replay is instant. */
const TIMEOUT_MS = mode === "record" ? 180_000 : undefined;
const NOW = "2026-10-22T12:00:00.000Z";

describe("correctClaims with Claude (cassette)", () => {
  it(
    "rewrites a wrong cap from the cited line, or removes it, and nothing else changes",
    async () => {
      const page = makeRevision({
        sections: [
          { key: "lead", claims: [leadClaim({ id: "c1", supports: ["c2", "c3"] })] },
          {
            key: "overview",
            claims: [
              bodyClaim({ id: "c2" }),
              bodyClaim({
                id: "c3",
                text: "At most 100 signals are made from one chunk.",
                citations: [codeCitation({ startLine: 7, endLine: 7, symbol: null })],
              }),
            ],
          },
        ],
      });
      const exp = WikiExport.parse({
        schemaVersion: SCHEMA_VERSION,
        repo: "sample",
        head: page.sha,
        exportedAt: NOW,
        manifest: makeManifest(),
        pages: [page],
        history: { signals: [page] },
      });
      const ledger = createLedger();
      const provider = createClaudeProvider({
        models: DEFAULT_MODELS,
        ledger,
        runId: "test-run",
        run: { kind: "update", sha: page.sha },
        apiKey: mode === "record" ? undefined : "cassette-replay",
        fetch: cassetteFetch(cassette("sample-correction"), mode),
      });
      const done = await correctClaims({
        exp,
        requests: [
          { page: "signals", claimId: "c3", note: "The cap is MAX_SIGNALS, which is 50." },
        ],
        ctx: testVerifyContext(),
        provider,
        now: NOW,
      });
      const [outcome] = done.outcomes;
      expect(outcome?.outcome).not.toBe("refused");
      const texts = done.exp.pages[0]?.sections.flatMap((s) => s.claims.map((c) => c.text)) ?? [];
      expect(texts).not.toContain("At most 100 signals are made from one chunk.");
      expect(texts).toContain("Signals are created from ingested chunks.");
      if (outcome?.outcome === "rewritten") expect(texts.some((t) => t.includes("50"))).toBe(true);
      expect(WikiExport.parse(done.exp)).toEqual(done.exp);
      for (const e of ledger.entries()) {
        expect(e).toMatchObject({ purpose: "write", batch: false, featureId: "signals" });
      }
    },
    TIMEOUT_MS,
  );
});
