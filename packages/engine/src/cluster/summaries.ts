import { posix } from "node:path";
import type { RepoIndex, SymbolKind } from "../index/index.ts";
import type { Cluster } from "./clusters.ts";
import type { FileGraph } from "./graph.ts";

/** What the manifest LLM call sees of a cluster: names and structure, never source text. */
export interface ClusterSummary {
  id: string;
  fileCount: number;
  symbolCount: number;
  /** "python 12", "tsx 3", "other 2": file counts by language, largest first. */
  languages: string[];
  /** Directories holding the cluster's files, most files first. */
  directories: { dir: string; files: number }[];
  /** The best-connected files inside the cluster. */
  files: string[];
  /** Exported symbols of the listed files, as "path#name". */
  symbols: string[];
  /** Third-party packages the cluster imports, most used first. */
  externalImports: string[];
  /** The clusters it shares the most edge weight with. */
  neighbours: { id: string; weight: number }[];
}

export interface SummaryLimits {
  files: number;
  symbols: number;
  directories: number;
  externalImports: number;
  neighbours: number;
}

export const DEFAULT_SUMMARY_LIMITS: SummaryLimits = {
  files: 25,
  symbols: 25,
  directories: 6,
  externalImports: 8,
  neighbours: 4,
};

const round = (n: number): number => Math.round(n * 100) / 100;

/** Types and functions say more about a cluster than module-level variables. Sorting is stable. */
const KIND_RANK: Record<SymbolKind, number> = {
  class: 0,
  interface: 0,
  type: 0,
  enum: 0,
  function: 1,
  method: 1,
  macro: 1,
  variable: 2,
  module: 2,
};

/** Rounds each weight first, so that weights equal as printed rank by name. */
function rounded(weights: Map<string, number> | undefined): Map<string, number> {
  return new Map([...(weights ?? [])].map(([id, weight]) => [id, round(weight)]));
}

/** Most common first; ties alphabetical. */
function ranked(counts: Map<string, number>): [string, number][] {
  return [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
}

const MAX_PACKAGE_LENGTH = 64;
const NPM_PACKAGE = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/;
const NODE_BUILTIN = /^node:[a-z0-9_/]+$/;
const PYTHON_MODULE = /^[A-Za-z_]\w*$/;

/**
 * The package a third-party import names: "os.path" from a .py file is "os", "@scope/pkg/sub" is
 * "@scope/pkg", "react-dom/client?raw" is "react-dom", "node:fs/promises" is "node:fs". An import
 * specifier is arbitrary text from a string literal, so anything that is not shaped like a package
 * name (a URL, a data: literal, prose, an over-long string) is dropped: a summary holds names only.
 */
function packageOf(from: string, rawSpecifier: string): string | null {
  const specifier = rawSpecifier.replace(/[?#][\s\S]*$/, "");
  let root: string;
  if (from.endsWith(".py") || from.endsWith(".rs")) {
    // A Rust use path names its crate first: "serde::Serialize" is "serde".
    root = specifier.split(from.endsWith(".rs") ? "::" : ".")[0] ?? "";
    if (!PYTHON_MODULE.test(root)) return null;
  } else if (specifier.startsWith("node:")) {
    if (!NODE_BUILTIN.test(specifier)) return null;
    root = `node:${specifier.slice("node:".length).split("/")[0]}`;
    if (root === "node:") return null;
  } else {
    root = specifier
      .split("/")
      .slice(0, specifier.startsWith("@") ? 2 : 1)
      .join("/");
    if (!NPM_PACKAGE.test(root)) return null;
  }
  return root.length > MAX_PACKAGE_LENGTH ? null : root;
}

export function summarizeClusters(
  index: RepoIndex,
  graph: FileGraph,
  clusters: readonly Cluster[],
  limits: SummaryLimits = DEFAULT_SUMMARY_LIMITS,
): ClusterSummary[] {
  const clusterOf = new Map<string, string>();
  for (const cluster of clusters) for (const file of cluster.files) clusterOf.set(file, cluster.id);
  const fileByPath = new Map(index.files.map((file) => [file.path, file]));

  const inner = new Map<string, number>();
  const between = new Map<string, Map<string, number>>();
  for (const { a, b, weight } of graph.edges) {
    const ca = clusterOf.get(a) ?? "";
    const cb = clusterOf.get(b) ?? "";
    if (ca === cb) {
      inner.set(a, (inner.get(a) ?? 0) + weight);
      inner.set(b, (inner.get(b) ?? 0) + weight);
      continue;
    }
    for (const [x, y] of [
      [ca, cb],
      [cb, ca],
    ] as const) {
      const map = between.get(x) ?? new Map<string, number>();
      map.set(y, (map.get(y) ?? 0) + weight);
      between.set(x, map);
    }
  }

  const external = new Map<string, Map<string, number>>();
  for (const miss of index.unresolved) {
    const id = clusterOf.get(miss.from);
    if (!miss.external || id === undefined) continue;
    const pkg = packageOf(miss.from, miss.specifier);
    if (pkg === null) continue;
    const map = external.get(id) ?? new Map<string, number>();
    map.set(pkg, (map.get(pkg) ?? 0) + 1);
    external.set(id, map);
  }

  return clusters.map((cluster) => {
    const files = cluster.files.flatMap((path) => fileByPath.get(path) ?? []);
    const languages = new Map<string, number>();
    const dirs = new Map<string, number>();
    for (const file of files) {
      const language = file.language ?? "other";
      languages.set(language, (languages.get(language) ?? 0) + 1);
      const dir = posix.dirname(file.path);
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
    const central = [...files].sort(
      (x, y) =>
        (inner.get(y.path) ?? 0) - (inner.get(x.path) ?? 0) ||
        (x.path < y.path ? -1 : x.path > y.path ? 1 : 0),
    );
    const listed = central.slice(0, limits.files);
    const symbols = listed
      .flatMap((file) => file.symbols.filter((s) => s.exported && s.kind !== "method"))
      .sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind])
      .slice(0, limits.symbols)
      .map((s) => s.id);
    return {
      id: cluster.id,
      fileCount: files.length,
      symbolCount: files.reduce((total, file) => total + file.symbols.length, 0),
      languages: ranked(languages).map(([language, n]) => `${language} ${n}`),
      directories: ranked(dirs)
        .slice(0, limits.directories)
        .map(([dir, n]) => ({ dir: dir === "." ? "(root)" : dir, files: n })),
      files: listed.map((file) => file.path),
      symbols,
      externalImports: ranked(external.get(cluster.id) ?? new Map())
        .slice(0, limits.externalImports)
        .map(([pkg]) => pkg),
      neighbours: ranked(rounded(between.get(cluster.id)))
        .slice(0, limits.neighbours)
        .map(([id, weight]) => ({ id, weight })),
    };
  });
}
