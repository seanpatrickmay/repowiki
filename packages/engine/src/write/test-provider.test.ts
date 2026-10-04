import { describe, expect, it } from "vitest";
import { ClaimFixes } from "../verify/index.ts";
import { pageProvider } from "./test-provider.ts";

const request = (featureId: string) => ({
  purpose: "write" as const,
  featureId,
  system: "s",
  messages: [{ role: "user" as const, content: "m" }],
  schema: ClaimFixes,
  maxTokens: 10,
});

describe("pageProvider", () => {
  it("puts a call made after an answer in a later turn, on every run", async () => {
    const { provider, requests } = pageProvider(() => ({ claims: [] }));
    await Promise.all([provider.generate(request("a")), provider.generate(request("b"))]);
    await provider.generate(request("a"));
    expect(requests.map((r) => [r.featureId, r.turn])).toEqual([
      ["a", 0],
      ["b", 0],
      ["a", 1],
    ]);
  });

  it("numbers each feature's calls from 1 and throws an Error answer", async () => {
    const seen: [string, number][] = [];
    const { provider } = pageProvider((featureId, call) => {
      seen.push([featureId, call]);
      return call === 2 ? new Error("boom") : { claims: [] };
    });
    await provider.generate(request("a"));
    await provider.generate(request("b"));
    await expect(provider.generate(request("a"))).rejects.toThrow("boom");
    expect(seen).toEqual([
      ["a", 1],
      ["b", 1],
      ["a", 2],
    ]);
  });
});
