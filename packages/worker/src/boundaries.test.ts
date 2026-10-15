import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK_MODULES, refusedImports, sourceImports } from "@repowiki/query/test-boundaries";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const RUNTIME = [
  "@repowiki/core",
  "@repowiki/engine",
  "@repowiki/hosted",
  "@repowiki/llm",
  "@repowiki/site",
  "zod",
];

describe("@repowiki/worker's boundaries (spec 2 S9)", () => {
  it("depends on the engine side only, never on the server", () => {
    const pkg = JSON.parse(readFileSync(`${SRC}/../package.json`, "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(RUNTIME);
  });

  it("imports its own modules, node built-ins but the network ones, and its dependencies only", () => {
    const allowed = (s: string) =>
      s.startsWith("./") ||
      (s.startsWith("node:") && !(NETWORK_MODULES as readonly string[]).includes(s)) ||
      RUNTIME.includes(s) ||
      s === "@repowiki/site/test-fixtures";
    const sources = sourceImports(SRC);
    expect(sources.has("api.ts")).toBe(true);
    expect(refusedImports(sources, allowed)).toEqual([]);
  });
});
