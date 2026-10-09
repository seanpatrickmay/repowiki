import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fetchCalls,
  fileImports,
  NETWORK_MODULES,
  refusedImports,
  sourceImports,
} from "./test-boundaries.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * @repowiki/query is the eval's retrieval over a wiki (C3): core and zod only. Its sources read
 * files at most; they spawn no process, open no socket and call no model.
 */
describe("@repowiki/query's boundaries", () => {
  const sources = sourceImports(SRC);

  it("finds the package's sources and leaves its tests out", () => {
    expect(sources.has("wiki-page.ts")).toBe(true);
    expect(sources.has("test-wiki.ts")).toBe(false);
    expect(sources.has("tools.test.ts")).toBe(false);
  });

  it("depends at run time on core and zod only", () => {
    const pkg = JSON.parse(readFileSync(`${SRC}/../package.json`, "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@repowiki/core", "zod"]);
  });

  it("imports only core, zod, its own modules and node's file and path modules", () => {
    const allowed = (s: string) =>
      s.startsWith("./") || ["@repowiki/core", "zod", "node:fs", "node:path"].includes(s);
    expect(refusedImports(sources, allowed)).toEqual([]);
    expect(fetchCalls(sources)).toEqual([]);
  });

  it("flags a refused import and a fetch call", () => {
    const fake = new Map([
      ["a.ts", { text: 'import { x } from "@repowiki/engine";\n', imports: ["@repowiki/engine"] }],
      ["b.ts", { text: "await fetch(url);\n", imports: [] }],
      ["c.ts", { text: "await globalThis.fetch(url);\n", imports: [] }],
      ["d.ts", { text: 'await globalThis["fetch"](url);\n', imports: [] }],
      ["e.ts", { text: "await client.fetch(url);\n", imports: [] }],
    ]);
    expect(sources.get("wiki-tools.ts")?.imports).toContain("zod");
    expect(refusedImports(fake, (s) => s.startsWith("./"))).toEqual([
      "a.ts imports @repowiki/engine",
    ]);
    expect(fetchCalls(fake)).toEqual(["b.ts calls fetch", "c.ts calls fetch", "d.ts calls fetch"]);
  });

  it("ships test helpers on subpaths that load no LLM or network module and call no fetch", () => {
    const pkg = JSON.parse(readFileSync(`${SRC}/../package.json`, "utf8"));
    const helpers = (Object.values(pkg.exports) as string[])
      .filter((path) => /\/test-[^/]*\.ts$/.test(path))
      .map((path) => path.replace(/^\.\/src\//, ""))
      .sort();
    expect(helpers).toEqual(["test-boundaries.ts", "test-wiki.ts"]);
    const shipped = fileImports(SRC, helpers);
    expect(shipped.get("test-wiki.ts")?.imports).toContain("@repowiki/engine/test-repo");
    const refused = ["@repowiki/llm", "@anthropic-ai/sdk", ...NETWORK_MODULES];
    const allowed = (s: string) => !refused.some((m) => s === m || s.startsWith(`${m}/`));
    expect(refusedImports(shipped, allowed)).toEqual([]);
    expect(fetchCalls(shipped)).toEqual([]);
  });
});
