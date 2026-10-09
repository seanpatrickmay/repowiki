import { posix } from "node:path";
import type { CargoManifest } from "./cargo.ts";
import type { RawImport } from "./imports.ts";

type RustImport = Extract<RawImport, { kind: "rust-use" | "rust-mod" }>;

const parentDir = (path: string): string =>
  posix.dirname(path) === "." ? "" : posix.dirname(path);
const join = (...parts: string[]): string => parts.filter((p) => p !== "").join("/");

/** A `[workspace] members` glob: `*` and `?` stay within one path segment. */
function globMatches(glob: string, path: string): boolean {
  const escaped = glob.replace(/[.+^$()|{}[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`).test(path);
}

/** Cargo's auto-discovered targets under a package: src/bin, tests, examples and benches. */
const AUTO_TARGET = /^(?:src\/bin|tests|examples|benches)\/[^/]+(?:\.rs|\/main\.rs)$/;

/**
 * Resolves Rust imports to module files. `mod a;` is `a.rs` or `a/mod.rs` in the directory its file
 * declares children in: a crate root's, `mod.rs`'s, `lib.rs`'s or `main.rs`'s own, `x/` for `x.rs`.
 * A `use` path is read from `crate::`, `self::`, `super::`, a workspace crate's name (with `-` as
 * `_`), a child module of the current one, or, when it starts with a capital, an item in scope
 * (the file itself); it resolves to the deepest module file it names. Anything else is external.
 * A file's module path comes from where it sits under its crate root, so `#[path]` modules are only
 * followed by `mod`, and an inline module of a lowercase name reads as an external crate.
 */
export function createRustResolver(
  files: ReadonlySet<string>,
  manifests: readonly CargoManifest[],
): (fromPath: string, raw: RustImport) => { targets: string[]; external: boolean } {
  const dirs = new Set<string>();
  for (const file of files)
    for (let dir = parentDir(file); dir !== "" && !dirs.has(dir); dir = parentDir(dir))
      dirs.add(dir);

  // A package inside a workspace's directory is a workspace crate only if a members glob names it.
  const workspaces = manifests.filter((m) => m.members !== null);
  const isMember = (m: CargoManifest) =>
    workspaces.every(
      (w) =>
        w.dir === m.dir ||
        (w.dir !== "" && !m.dir.startsWith(`${w.dir}/`)) ||
        (w.members ?? []).some((glob) => globMatches(glob, m.dir)),
    );
  const libOf = new Map<string, string>();
  const roots: string[] = [];
  for (const m of manifests) {
    if (!m.package) continue;
    const prefix = m.dir === "" ? "" : `${m.dir}/`;
    const lib = m.lib ?? `${prefix}src/lib.rs`;
    const auto = [...files].filter(
      (f) => f.startsWith(prefix) && AUTO_TARGET.test(f.slice(prefix.length)),
    );
    roots.push(
      ...[lib, `${prefix}src/main.rs`, ...m.bins, ...auto.sort()].filter((f) => files.has(f)),
    );
    if (m.crate !== null && isMember(m) && files.has(lib) && !libOf.has(m.crate))
      libOf.set(m.crate, lib);
  }
  const rootSet = new Set(roots);

  /** A file's crate root (itself, else the root with the deepest directory above it; a lib first) and module path. */
  const moduleOf = (path: string): { root: string; module: string[] } | null => {
    if (rootSet.has(path)) return { root: path, module: [] };
    let best: string | null = null;
    for (const root of roots) {
      const dir = parentDir(root);
      const above = dir === "" || path.startsWith(`${dir}/`);
      if (above && (best === null || dir.length > parentDir(best).length)) best = root;
    }
    if (best === null) return null;
    const dir = parentDir(best);
    const rest = (dir === "" ? path : path.slice(dir.length + 1)).replace(/(?:\/mod)?\.rs$/, "");
    return { root: best, module: rest.split("/") };
  };

  const moduleFile = (dir: string): string | undefined =>
    [`${dir}.rs`, `${dir}/mod.rs`].find((f) => files.has(f));

  /** The deepest module file that `segments`, read from the crate root, name. */
  const resolved = (root: string, segments: readonly string[]) => {
    let found = root;
    let dir = parentDir(root);
    for (const segment of segments) {
      dir = join(dir, segment);
      const file = moduleFile(dir);
      if (file !== undefined) found = file;
      else if (!dirs.has(dir)) break; // A directory of files can sit under an inline module.
    }
    return { targets: [found], external: false };
  };

  const none = { targets: [], external: false };
  return (fromPath, raw) => {
    if (raw.kind === "rust-mod") {
      const own =
        rootSet.has(fromPath) || /(?:^|\/)(?:mod|lib|main)\.rs$/.test(fromPath)
          ? parentDir(fromPath)
          : fromPath.replace(/\.rs$/, "");
      // A #[path] outside inline modules is relative to the file's own directory.
      const base = raw.file !== null && raw.scope.length === 0 ? parentDir(fromPath) : own;
      const dir = join(base, ...raw.scope);
      const file =
        raw.file === null ? moduleFile(join(dir, raw.name)) : posix.normalize(join(dir, raw.file));
      return file !== undefined && files.has(file) ? { targets: [file], external: false } : none;
    }
    const at = moduleOf(fromPath);
    const here = at === null ? [] : [...at.module, ...raw.scope];
    const [first = "", ...rest] = raw.path;
    if (first === "crate") return at === null ? none : resolved(at.root, rest);
    if (first === "self" || first === "super") {
      if (at === null) return none;
      let up = first === "self" ? 1 : 0;
      for (; raw.path[up] === "super"; up++) if (here.pop() === undefined) return none;
      return resolved(at.root, [...here, ...raw.path.slice(up)]);
    }
    const lib = libOf.get(first);
    if (lib !== undefined) return resolved(lib, rest);
    const child = at === null ? "" : join(parentDir(at.root), ...here, first);
    if (at !== null && (moduleFile(child) !== undefined || dirs.has(child))) {
      return resolved(at.root, [...here, ...raw.path]);
    }
    if (/^[A-Z]/.test(first)) return { targets: [fromPath], external: false };
    return { targets: [], external: true };
  };
}
