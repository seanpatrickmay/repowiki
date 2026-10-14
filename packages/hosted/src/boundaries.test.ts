import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchCalls, refusedImports, sourceImports } from "@repowiki/query/test-boundaries";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/** Clock, randomness and environment reads a hosted source may not make: callers pass them in. */
const IMPURE = /\bDate\.now\s*\(|new Date\(\s*\)|Math\.random\s*\(|\brandomUUID\b|\bprocess\./;

/** @repowiki/hosted is the hosted product's rules as pure functions (Contract spec C1). */
describe("@repowiki/hosted's boundaries", () => {
  const sources = sourceImports(SRC);

  it("finds the package's sources and leaves its tests out", () => {
    expect(sources.has("limits.ts")).toBe(true);
    expect(sources.has("limits.test.ts")).toBe(false);
  });

  it("depends at run time on core and zod only", () => {
    const pkg = JSON.parse(readFileSync(`${SRC}/../package.json`, "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@repowiki/core", "zod"]);
  });

  it("imports only core, zod and its own modules, and calls no fetch", () => {
    const allowed = (s: string) => s.startsWith("./") || ["@repowiki/core", "zod"].includes(s);
    expect(refusedImports(sources, allowed)).toEqual([]);
    expect(fetchCalls(sources)).toEqual([]);
  });

  it("reads no clock, randomness or environment", () => {
    const impure = [...sources].filter(([, s]) => IMPURE.test(s.text)).map(([path]) => path);
    expect(impure).toEqual([]);
    expect(IMPURE.test("const t = Date.now();")).toBe(true);
    expect(IMPURE.test("const t = new Date();")).toBe(true);
    expect(IMPURE.test("const t = new Date(at);")).toBe(false);
  });
});
