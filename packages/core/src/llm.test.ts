import { describe, expect, it } from "vitest";
import { LedgerEntry, LlmConfigFile } from "./llm.ts";
import { makeLedgerEntry } from "./test-fixtures.ts";

describe("LedgerEntry", () => {
  it("accepts a recorded call", () => {
    expect(LedgerEntry.parse(makeLedgerEntry())).toEqual(makeLedgerEntry());
  });

  it.each([
    ["an unknown purpose", { purpose: "summarize" }],
    ["negative tokens", { tokens: { in: -1, out: 0, cacheRead: 0, cacheWrite: 0 } }],
    ["a timestamp without offset", { at: "2026-10-01 12:00" }],
    ["a non-slug feature id", { featureId: "Signals" }],
    ["an unknown run kind", { runKind: "replay" }],
    ["a short sha", { sha: "abc1234" }],
  ])("rejects %s", (_name, overrides) => {
    expect(LedgerEntry.safeParse({ ...makeLedgerEntry(), ...overrides }).success).toBe(false);
  });
});

describe("LedgerEntry run fields (spec §6.4)", () => {
  it("accepts a row that names its run kind and sha", () => {
    const entry = makeLedgerEntry({ runKind: "build", sha: "a".repeat(40) });
    expect(LedgerEntry.parse(entry)).toEqual(entry);
  });

  it("still reads a row written before runs had a kind or sha", () => {
    const parsed = LedgerEntry.parse(JSON.parse(JSON.stringify(makeLedgerEntry())));
    expect(parsed).not.toHaveProperty("runKind");
    expect(parsed).not.toHaveProperty("sha");
  });
});

describe("LlmConfigFile", () => {
  it("accepts per-role overrides and defaults to none", () => {
    expect(LlmConfigFile.parse({ models: { write: "claude-sonnet-5-5" } })).toEqual({
      models: { write: "claude-sonnet-5-5" },
    });
    expect(LlmConfigFile.parse({})).toEqual({ models: {} });
  });

  it.each([
    ["an unknown role", { models: { summarize: "claude-haiku-4-5" } }],
    ["an empty model id", { models: { manifest: "" } }],
    ["an unknown top-level key", { model: "claude-haiku-4-5" }],
  ])("rejects %s", (_name, file) => {
    expect(LlmConfigFile.safeParse(file).success).toBe(false);
  });
});
