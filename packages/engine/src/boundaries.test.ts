import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The engine module a src-relative path belongs to; "" for files directly in src/. */
function moduleOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * A relative specifier in an import/export statement that starts a line. Anchoring to the line
 * start and refusing quotes before `from` keeps source text held in string fixtures from matching.
 */
const STATIC_IMPORT =
  /^(?:import|export)\s[^;"'`]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']|^import\s*["'](\.{1,2}\/[^"']+)["']/gm;

/** Relative imports that enter another module anywhere but its index.ts. */
function boundaryViolations(sources: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, source] of sources) {
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[1] ?? match[2] ?? "";
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      const to = moduleOf(target);
      if (moduleOf(path) === to || (to !== "" && target === `${to}/index.ts`)) continue;
      violations.push(`${path} imports ${specifier}`);
    }
  }
  return violations.sort();
}

/** Every .ts file under root, keyed by its root-relative POSIX path. */
function readSources(root: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const full = join(entry.parentPath, entry.name);
    sources.set(relative(root, full).split(sep).join("/"), readFileSync(full, "utf8"));
  }
  return sources;
}

describe("engine module boundaries", () => {
  it("allows same-module imports and cross-module imports through index.ts", () => {
    const sources = new Map([
      ["index/a.ts", 'import { x } from "../store/index.ts";\nimport y from "./b.ts";\n'],
      ["index.ts", 'export { a } from "./index/index.ts";\n'],
    ]);
    expect(boundaryViolations(sources)).toEqual([]);
  });

  it("flags imports of another module's internals and of the package entry", () => {
    const sources = new Map([
      ["index/a.ts", 'import type { Store } from "../store/store.ts";\n'],
      ["store/s.ts", 'import "../index.ts";\n'],
      ["index.ts", 'export { openStore } from "./store/store.ts";\n'],
    ]);
    expect(boundaryViolations(sources)).toEqual([
      "index.ts imports ./store/store.ts",
      "index/a.ts imports ../store/store.ts",
      "store/s.ts imports ../index.ts",
    ]);
  });

  it("ignores import-like text inside string literals", () => {
    const sources = new Map([
      ["index/a.test.ts", "const fixture = 'export * from \"../store/store.ts\";';\n"],
    ]);
    expect(boundaryViolations(sources)).toEqual([]);
  });

  it("holds for the engine source tree", () => {
    const sources = readSources(dirname(fileURLToPath(import.meta.url)));
    expect(boundaryViolations(sources)).toEqual([]);
  });
});
