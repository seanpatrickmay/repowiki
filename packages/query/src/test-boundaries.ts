import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** A specifier in an import or export statement that starts a line, or in a dynamic import(). */
const IMPORT =
  /^(?:import|export)\s[^;"'`]*?\bfrom\s*["']([^"']+)["']|^import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

/** A test file or a test-only helper: these may import what the package's sources may not. */
const isTestFile = (path: string) => /(^|\/)test-[^/]*\.ts$|\.test\.ts$/.test(path);

/**
 * Every non-test .ts source under `root` (a package's src/), keyed by its root-relative POSIX
 * path, with the module specifiers it imports. Test-only.
 */
export function sourceImports(root: string): Map<string, { text: string; imports: string[] }> {
  const sources = new Map<string, { text: string; imports: string[] }>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const full = join(entry.parentPath, entry.name);
    const path = relative(root, full).split(sep).join("/");
    if (isTestFile(path)) continue;
    const text = readFileSync(full, "utf8");
    const imports = [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
    sources.set(path, { text, imports });
  }
  return sources;
}

/** Network modules no query or mcp source may load (spec v2 #5 §4). */
export const NETWORK_MODULES = [
  "node:http",
  "node:https",
  "node:http2",
  "node:net",
  "node:tls",
  "node:dgram",
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
] as const;

/** "path imports x" for every import of `sources` that `allowed` refuses. */
export function refusedImports(
  sources: ReadonlyMap<string, { imports: readonly string[] }>,
  allowed: (specifier: string) => boolean,
): string[] {
  return [...sources]
    .flatMap(([path, { imports }]) =>
      imports.filter((s) => !allowed(s)).map((s) => `${path} imports ${s}`),
    )
    .sort();
}

/** "path calls fetch" for every source that calls the global fetch. */
export function fetchCalls(sources: ReadonlyMap<string, { text: string }>): string[] {
  return [...sources].flatMap(([path, { text }]) =>
    /(^|[^\w.])fetch\s*\(/m.test(text) ? [`${path} calls fetch`] : [],
  );
}
