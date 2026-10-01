import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cassetteFetch, cassetteMode } from "./cassette.ts";
import { createClaudeProvider } from "./claude.ts";
import { createLedger, totalsOf } from "./ledger.ts";
import { callCostUsd } from "./pricing.ts";
import { DEFAULT_MODELS } from "./provider.ts";

const mode = cassetteMode();
/** A live batch can take over an hour (two recordings took about 70 minutes); a replay is instant. */
const BATCH_TIMEOUT_MS = mode === "record" ? 14_400_000 : 5_000;
/** Two live calls and a cache write; replays use the default timeout. */
const CACHE_TIMEOUT_MS = mode === "record" ? 60_000 : undefined;
const cassette = (name: string) =>
  fileURLToPath(new URL(`./__cassettes__/${name}.json`, import.meta.url));

function setup(name: string) {
  const ledger = createLedger();
  const provider = createClaudeProvider({
    models: DEFAULT_MODELS,
    ledger,
    runId: "test-run",
    // Replays never reach the API, but the SDK still wants a credential.
    apiKey: mode === "record" ? undefined : "cassette-replay",
    fetch: cassetteFetch(cassette(name), mode),
    pollIntervalMs: mode === "record" ? 60_000 : 0,
    now: () => new Date("2026-10-01T12:00:00Z"),
  });
  return { ledger, provider };
}

/** Deterministic filler, well above Haiku 4.5's 4096-token minimum cacheable prefix. */
const GLOSSARY = Array.from(
  { length: 320 },
  (_, i) =>
    `Term ${String(i).padStart(3, "0")}: entry ${i} of the RepoWiki test glossary, describing component number ${i * 7} and its neighbour ${i * 7 + 3}.`,
).join("\n");

const Capital = z.object({ city: z.string(), country: z.string() });

describe("createClaudeProvider against recorded Claude API exchanges", () => {
  it("returns schema-checked JSON output", async () => {
    const { ledger, provider } = setup("structured-output");
    const result = await provider.generate({
      purpose: "manifest",
      system: "Answer with JSON only.",
      messages: [{ role: "user", content: "What is the capital of France?" }],
      schema: Capital,
      maxTokens: 200,
    });
    expect(result.output.city).toBe("Paris");
    expect(result.model).toMatch(/^claude-haiku-4-5/);
    expect(ledger.entries()[0]?.tokens.in).toBeGreaterThan(0);
  });

  it(
    "caches a long prefix: the second call reads what the first wrote",
    async () => {
      const { ledger, provider } = setup("prompt-cache");
      const ask = (n: number) =>
        provider.generate({
          purpose: "write",
          system: `Use this glossary to answer.\n\n${GLOSSARY}`,
          messages: [{ role: "user", content: `Which component does term ${n} describe?` }],
          schema: z.object({ component: z.number() }),
          maxTokens: 100,
          cacheKey: "glossary",
        });
      expect((await ask(10)).output.component).toBe(70);
      expect((await ask(20)).output.component).toBe(140);
      const [first, second] = ledger.entries().map((e) => e.tokens);
      if (first === undefined || second === undefined)
        throw new Error("expected two ledger entries");
      // A re-recording within five minutes of the last one reads instead of writing.
      const prefixTokens = first.cacheWrite + first.cacheRead;
      expect(prefixTokens).toBeGreaterThan(4096);
      expect(second.cacheRead).toBe(prefixTokens);
      expect(second.cacheWrite).toBe(0);
    },
    CACHE_TIMEOUT_MS,
  );

  it(
    "sends calls made in the same tick as one Message Batch",
    async () => {
      const { ledger, provider } = setup("batch");
      const ask = (country: string) =>
        provider.generate({
          purpose: "manifest",
          featureId: "capitals",
          system: "Answer with JSON only.",
          messages: [{ role: "user", content: `What is the capital of ${country}?` }],
          schema: Capital,
          maxTokens: 200,
          batch: true,
        });
      const [japan, peru] = await Promise.all([ask("Japan"), ask("Peru")]);
      expect(japan.output.city).toBe("Tokyo");
      expect(peru.output.city).toBe("Lima");
      expect(ledger.entries().map((e) => [e.batch, e.featureId])).toEqual([
        [true, "capitals"],
        [true, "capitals"],
      ]);
      // Batch calls bill at half the unbatched price for the same tokens.
      const entries = ledger.entries();
      const unbatched = entries.reduce(
        (sum, e) => sum + (callCostUsd(e.model, e.tokens, false) ?? Number.NaN),
        0,
      );
      expect(unbatched).toBeGreaterThan(0);
      expect(totalsOf(entries).usd).toBeCloseTo(unbatched * 0.5, 10);
    },
    BATCH_TIMEOUT_MS,
  );

  it("keeps API keys and auth headers out of every cassette", () => {
    for (const name of ["structured-output", "prompt-cache", "batch"]) {
      expect(readFileSync(cassette(name), "utf8")).not.toMatch(/sk-ant|x-api-key|authorization/i);
    }
  });
});
