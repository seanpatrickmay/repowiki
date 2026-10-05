import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchCalls,
  NETWORK_MODULES,
  refusedImports,
  sourceImports,
} from "@repowiki/query/test-boundaries";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * The MCP server spends no LLM tokens and opens no socket (spec v2 #5 R1, R6): no source of
 * @repowiki/mcp imports @repowiki/llm or a network module, or calls fetch. engine loads llm as a
 * package, but nothing here can construct a provider.
 */
describe("@repowiki/mcp's boundaries", () => {
  const sources = sourceImports(SRC);

  it("finds the package's sources", () => {
    expect(sources.has("git.ts")).toBe(true);
    expect(sources.has("code.ts")).toBe(true);
  });

  it("depends on core, engine, query and zod", () => {
    const pkg = JSON.parse(readFileSync(`${SRC}/../package.json`, "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@repowiki/core",
      "@repowiki/engine",
      "@repowiki/query",
      "zod",
    ]);
  });

  it("imports no LLM or network module, nor a subpath of one, and calls no fetch", () => {
    const refused = new Set<string>(["@repowiki/llm", "@anthropic-ai/sdk", ...NETWORK_MODULES]);
    const allowed = (s: string) => ![...refused].some((m) => s === m || s.startsWith(`${m}/`));
    for (const subpath of ["@repowiki/llm/cassette", "@anthropic-ai/sdk/resources", "node:net"]) {
      expect(allowed(subpath), subpath).toBe(false);
    }
    expect(allowed("@repowiki/llm-free")).toBe(true);
    expect(refusedImports(sources, allowed)).toEqual([]);
    expect(fetchCalls(sources)).toEqual([]);
  });

  it("never writes to stdout but through stdio.ts's output: no console.log, console.info or process.stdout", () => {
    const writers = [...sources]
      .filter(([, { text }]) => /console\.(log|info|debug|table)\b|process\.stdout/.test(text))
      .map(([path]) => path);
    expect(writers).toEqual([]);
  });
});
