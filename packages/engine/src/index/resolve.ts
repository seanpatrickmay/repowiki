import { posix } from "node:path";
import type { RawImport } from "./imports.ts";

export interface WorkspacePackage {
  name: string;
  /** Subpath ("." or "./x") → repo-relative target file. */
  exports: Record<string, string>;
}

export interface ImportResolution {
  /** Repo files the import loads; empty when unresolved. */
  targets: string[];
  /** True when the import names something outside the repo (stdlib, npm, PyPI). */
  external: boolean;
}

export interface Resolver {
  resolve(fromPath: string, raw: RawImport): ImportResolution;
}

/** Repo-relative join; "" is the repo root. */
function joinRepo(...parts: string[]): string {
  const joined = posix.normalize(parts.filter((p) => p !== "").join("/"));
  return joined === "." ? "" : joined;
}

function parentDir(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const conditions = value as Record<string, unknown>;
    for (const key of ["import", "default", "types"]) {
      if (typeof conditions[key] === "string") return conditions[key] as string;
    }
  }
  return null;
}

function exportMap(pkg: Record<string, unknown>): Record<string, unknown> {
  const { exports, main } = pkg;
  if (typeof exports === "string") return { ".": exports };
  if (exports !== null && typeof exports === "object") {
    const map = exports as Record<string, unknown>;
    // An object without "." keys is a set of conditions for the root export.
    return Object.keys(map).some((key) => key.startsWith(".")) ? map : { ".": map };
  }
  return typeof main === "string" ? { ".": main } : {};
}

/** Reads a tracked package.json; returns null if it is not a named package. */
export function parseWorkspacePackage(
  packageJsonPath: string,
  text: string,
): WorkspacePackage | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object") return null;
  const pkg = json as Record<string, unknown>;
  if (typeof pkg.name !== "string") return null;
  const dir = parentDir(packageJsonPath);
  const exports: Record<string, string> = {};
  for (const [subpath, value] of Object.entries(exportMap(pkg))) {
    const target = exportTarget(value);
    if (target !== null && subpath.startsWith(".")) exports[subpath] = joinRepo(dir, target);
  }
  return { name: pkg.name, exports };
}

const ES_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

export function createResolver(
  paths: readonly string[],
  packages: readonly WorkspacePackage[],
): Resolver {
  const files = new Set(paths);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));

  // A Python source root is the parent of a top-level package (a dir with __init__.py whose parent has none).
  const pythonRoots = new Set<string>([""]);
  for (const path of files) {
    if (posix.basename(path) !== "__init__.py") continue;
    const parent = parentDir(parentDir(path));
    if (!files.has(joinRepo(parent, "__init__.py"))) pythonRoots.add(parent);
  }
  const roots = [...pythonRoots].sort();

  const pythonModule = (base: string, dotted: string): string | null => {
    const asPath = dotted
      .split(".")
      .filter((s) => s !== "")
      .join("/");
    for (const candidate of asPath === ""
      ? [joinRepo(base, "__init__.py")]
      : [joinRepo(base, `${asPath}.py`), joinRepo(base, asPath, "__init__.py")]) {
      if (files.has(candidate)) return candidate;
    }
    return null;
  };

  const resolvePython = (
    fromPath: string,
    raw: Extract<RawImport, { kind: "python" }>,
  ): ImportResolution => {
    let bases = roots;
    if (raw.level > 0) {
      let base = parentDir(fromPath);
      for (let i = 1; i < raw.level; i++) {
        if (base === "") return { targets: [], external: false };
        base = parentDir(base);
      }
      bases = [base];
    }
    const find = (dotted: string): string | null => {
      for (const base of bases) {
        const hit = pythonModule(base, dotted);
        if (hit !== null) return hit;
      }
      return null;
    };
    const targets = new Set<string>();
    let needsModule = raw.names.length === 0;
    for (const name of raw.names) {
      const submodule = find(raw.module === "" ? name : `${raw.module}.${name}`);
      if (submodule !== null) targets.add(submodule);
      else needsModule = true;
    }
    if (needsModule) {
      const module = find(raw.module);
      if (module !== null) targets.add(module);
    }
    return { targets: [...targets].sort(), external: raw.level === 0 && targets.size === 0 };
  };

  const resolveFile = (candidate: string): string | null => {
    if (candidate !== "") {
      if (files.has(candidate)) return candidate;
      // TypeScript ESM source imports "./a.js" for the file a.ts.
      if (/\.[cm]?jsx?$/.test(candidate)) {
        for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
          const swapped = candidate.replace(/\.[cm]?jsx?$/, ext);
          if (files.has(swapped)) return swapped;
        }
      }
      for (const ext of ES_EXTENSIONS) {
        if (files.has(`${candidate}${ext}`)) return `${candidate}${ext}`;
      }
    }
    const dir = candidate === "" ? "" : `${candidate}/`;
    for (const ext of ES_EXTENSIONS) {
      if (files.has(`${dir}index${ext}`)) return `${dir}index${ext}`;
    }
    return null;
  };

  const resolveEs = (fromPath: string, specifier: string): ImportResolution => {
    if (
      specifier === "." ||
      specifier === ".." ||
      specifier.startsWith("./") ||
      specifier.startsWith("../")
    ) {
      const joined = posix.normalize(posix.join(parentDir(fromPath) || ".", specifier));
      if (joined === ".." || joined.startsWith("../")) return { targets: [], external: false };
      const hit = resolveFile(joined === "." ? "" : joined);
      return { targets: hit === null ? [] : [hit], external: false };
    }
    if (specifier.startsWith("/")) return { targets: [], external: false };
    const segments = specifier.split("/");
    const nameLength = specifier.startsWith("@") ? 2 : 1;
    const pkg = byName.get(segments.slice(0, nameLength).join("/"));
    if (pkg === undefined) return { targets: [], external: true };
    const rest = segments.slice(nameLength).join("/");
    const target = pkg.exports[rest === "" ? "." : `./${rest}`];
    const hit = target === undefined ? null : resolveFile(target);
    return { targets: hit === null ? [] : [hit], external: false };
  };

  return {
    resolve: (fromPath, raw) =>
      raw.kind === "python" ? resolvePython(fromPath, raw) : resolveEs(fromPath, raw.specifier),
  };
}
