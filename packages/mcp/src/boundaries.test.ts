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

  it("never writes to stdout but through stdio.ts's output: no console printer, process.stdout or fd 1", () => {
    // Every console method that prints to stdout, stdout by any spelling, and fd 1 written raw.
    const STDOUT_WRITER =
      /console\.(log|info|debug|table|dir|dirxml|count|group|groupCollapsed|timeEnd|timeLog)\b|process\s*(\.\s*stdout\b|\[\s*["'`]stdout["'`]\s*\])|\bwrite(Sync)?\(\s*1\s*,/;
    const writesStdout = (text: string) => STDOUT_WRITER.test(text);
    for (const sample of [
      "console.dir(x)",
      "console.dirxml(x)",
      "console.count()",
      "console.group('a')",
      "console.groupCollapsed()",
      "console.timeEnd('t')",
      "console.timeLog('t')",
      'process["stdout"].write(x)',
      "process['stdout']",
      "fs.writeSync(1, text)",
      "writeSync( 1 ,text)",
      "fs.write(1, text, () => {})",
    ]) {
      expect(writesStdout(sample), sample).toBe(true);
    }
    expect(writesStdout("console.error(logLine(x))")).toBe(false);
    expect(writesStdout("writeSync(10, text)")).toBe(false);
    const writers = [...sources].filter(([, { text }]) => writesStdout(text)).map(([path]) => path);
    expect(writers).toEqual([]);
  });
});
