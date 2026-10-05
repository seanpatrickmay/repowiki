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
 * @repowiki/ask answers questions in a process that never opens SQLite or tree-sitter (spec v2 #4
 * R15): it loads no engine, eval or site, and calls the model only through @repowiki/llm's
 * provider. Its HTTP handler takes node:http's request and response; it opens no socket itself.
 */
describe("@repowiki/ask's boundaries", () => {
  const sources = sourceImports(SRC);

  it("finds the package's sources and leaves its tests out", () => {
    expect(sources.has("pack.ts")).toBe(true);
    expect(sources.has("pack.test.ts")).toBe(false);
  });

  it("depends on core, llm, query and zod", () => {
    const pkg = JSON.parse(readFileSync(`${SRC}/../package.json`, "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@repowiki/core",
      "@repowiki/llm",
      "@repowiki/query",
      "zod",
    ]);
  });

  it("imports no engine, eval, site or network module, and calls no fetch", () => {
    const packages = ["@repowiki/core", "@repowiki/llm", "@repowiki/query", "zod"];
    const node = ["node:crypto", "node:fs", "node:path"];
    const allowed = (s: string) => s.startsWith("./") || packages.includes(s) || node.includes(s);
    expect(refusedImports(sources, allowed)).toEqual([]);
    expect(fetchCalls(sources)).toEqual([]);
    expect(NETWORK_MODULES.some((m) => allowed(m))).toBe(false);
  });
});
