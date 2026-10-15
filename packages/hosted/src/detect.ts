import { RepoPath } from "@repowiki/core";
import { z } from "zod";
import { manifestKind, readManifest } from "./manifests.ts";
import {
  type Ecosystem,
  isTool,
  KIND_PRIORITY,
  normalizedName,
  packageMatches,
  TECHNOLOGIES,
  type Technology,
  technologyForPackage,
} from "./technologies.ts";

/** A generation stores at most this many technologies (ADR-0014). */
export const MAX_TECHNOLOGIES = 60;

/** One technology a project uses, the file that proves it, and how many indexed files import it. */
export const TechnologyUse = z.strictObject({
  id: z
    .string()
    .max(40)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  evidence: z.strictObject({ path: z.string().max(1000).pipe(RepoPath) }),
  /** Null when none of the technology's ecosystems has import data. */
  importingFiles: z.int().nonnegative().nullable(),
});
export type TechnologyUse = z.infer<typeof TechnologyUse>;

/** Vendored, installed and built copies are not the project's own choices. */
const SKIPPED = /(?:^|\/)(?:node_modules|vendor|\.venv|dist|build|target)\//;
const kept = (paths: readonly string[]) => paths.filter((p) => !SKIPPED.test(p));
const depth = (path: string) => path.split("/").length;
/** Shallowest first, then by path. */
const byDepth = (a: string, b: string) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0);

const PATH_RULES = TECHNOLOGIES.flatMap((tech) => (tech.paths ?? []).map((re) => ({ tech, re })));

/** The paths detection reads: manifests, compose files and infrastructure files, in tree order. */
export function technologyPaths(paths: readonly string[]): string[] {
  return kept(paths).filter(
    (p) => manifestKind(p) !== null || PATH_RULES.some(({ re }) => re.test(p)),
  );
}

/** The paths whose contents detection needs, shallowest first, at most `max`. */
export function sourcePaths(paths: readonly string[], max: number): string[] {
  return kept(paths)
    .filter((p) => manifestKind(p) !== null)
    .sort(byDepth)
    .slice(0, max);
}

/** Files the engine parses, by the ecosystem their imports name; JavaScript and Go are not. */
const PARSED: Partial<Record<Ecosystem, RegExp>> = {
  npm: /\.(?:tsx|[cm]?ts)$/,
  pypi: /\.py$/,
  crates: /\.rs$/,
};
const NPM_PACKAGE = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/;
const PYTHON_MODULE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const RUST_CRATE = /^[A-Za-z_]\w*$/;
const RUST_LOCAL = new Set(["crate", "self", "super", "std", "core", "alloc"]);

/**
 * The package an import in `from` names: the npm package root, the whole Python module path, or
 * the Rust crate; null for a relative, built-in or malformed specifier, or a file the engine
 * does not parse.
 */
export function importName(
  from: string,
  specifier: string,
): { ecosystem: Ecosystem; name: string } | null {
  if (PARSED.pypi?.test(from)) {
    return PYTHON_MODULE.test(specifier) ? { ecosystem: "pypi", name: specifier } : null;
  }
  if (PARSED.crates?.test(from)) {
    const crate = specifier.split("::")[0] ?? "";
    return RUST_CRATE.test(crate) && !RUST_LOCAL.has(crate)
      ? { ecosystem: "crates", name: crate }
      : null;
  }
  if (!PARSED.npm?.test(from)) return null;
  const spec = specifier.replace(/[?#][\s\S]*$/, "").toLowerCase();
  const root = spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");
  return NPM_PACKAGE.test(root) && root.length <= 214 ? { ecosystem: "npm", name: root } : null;
}

/** Whether a Python module path is `alias` or inside it, ignoring case. */
const underModule = (module: string, alias: string) => {
  const m = module.toLowerCase();
  const a = alias.toLowerCase();
  return m === a || m.startsWith(`${a}.`);
};

/** The table entry an import names, by its aliases first, then by its package names. */
function importedTechnology(ecosystem: Ecosystem, name: string): Technology | null {
  const aliased = TECHNOLOGIES.find((tech) =>
    (tech.imports?.[ecosystem] ?? []).some((alias) =>
      ecosystem === "pypi"
        ? underModule(name, alias)
        : packageMatches(normalizedName(ecosystem, alias), normalizedName(ecosystem, name)),
    ),
  );
  if (aliased !== undefined) return aliased;
  return technologyForPackage(ecosystem, ecosystem === "pypi" ? (name.split(".")[0] ?? "") : name);
}

/** The repository names a compose image may match: with its namespace, then without. */
export function imageCandidates(image: string): string[] {
  const parts = (image.toLowerCase().split("@")[0] ?? "").split("/");
  parts.push((parts.pop() ?? "").split(":")[0] ?? "");
  if (parts.length > 1 && (/[.:]/.test(parts[0] ?? "") || parts[0] === "localhost")) parts.shift();
  if (parts.length > 1 && parts[0] === "library") parts.shift();
  return [...new Set([parts.join("/"), parts.at(-1) ?? ""])].filter((c) => c !== "");
}

const technologyForImage = (image: string) => {
  for (const candidate of imageCandidates(image)) {
    const tech = TECHNOLOGIES.find((t) => (t.images ?? []).includes(candidate));
    if (tech !== undefined) return tech;
  }
  return null;
};

interface Found {
  tech: Technology;
  declared?: string;
  file?: string;
  importers: Set<string>;
}

const kindRank = (tech: Technology) => KIND_PRIORITY.indexOf(tech.kind);

/**
 * The technologies a repository's tree shows (ADR-0014): what its manifests declare, its compose
 * files run, its infrastructure files configure and its indexed files import, each in the curated
 * table, under the shown rule. `sources` holds the contents of manifest and compose files;
 * `imports` is the index's external imports, or null when there is no index (local import mode).
 * A file that will not parse adds nothing and is listed in `unparsed`.
 */
export function detectTechnologies(input: {
  paths: readonly string[];
  sources: ReadonlyMap<string, string>;
  imports: readonly { from: string; specifier: string }[] | null;
}): { technologies: TechnologyUse[]; unparsed: string[] } {
  const paths = kept(input.paths);
  const found = new Map<string, Found>();
  const entry = (tech: Technology) => {
    const known = found.get(tech.id) ?? { tech, importers: new Set<string>() };
    found.set(tech.id, known);
    return known;
  };
  const unparsed: string[] = [];
  for (const path of sourcePaths([...input.sources.keys()], Number.POSITIVE_INFINITY)) {
    const read = readManifest(path, input.sources.get(path) ?? "");
    if (read === null) {
      unparsed.push(path);
      continue;
    }
    for (const { ecosystem, name } of read.declared) {
      const tech = technologyForPackage(ecosystem, name);
      if (tech !== null) entry(tech).declared ??= path;
    }
    for (const image of read.images) {
      const tech = technologyForImage(image);
      if (tech !== null) entry(tech).file ??= path;
    }
  }
  for (const path of [...paths].sort(byDepth)) {
    for (const { tech, re } of PATH_RULES) if (re.test(path)) entry(tech).file ??= path;
  }
  const names = new Map<string, Technology | null>();
  for (const { from, specifier } of input.imports ?? []) {
    if (SKIPPED.test(from)) continue;
    const imported = importName(from, specifier);
    if (imported === null) continue;
    const key = `${imported.ecosystem}:${imported.name}`;
    if (!names.has(key)) names.set(key, importedTechnology(imported.ecosystem, imported.name));
    const tech = names.get(key);
    if (tech) entry(tech).importers.add(from);
  }

  // An ecosystem has import data when there is an index and the tree has a file it parses.
  const withData = new Set(
    (Object.keys(PARSED) as Ecosystem[]).filter(
      (e) => input.imports !== null && paths.some((p) => PARSED[e]?.test(p)),
    ),
  );
  const technologies = [...found.values()].flatMap(({ tech, declared, file, importers }) => {
    const ecosystems = (Object.keys(tech.packages) as Ecosystem[]).concat(
      Object.keys(tech.imports ?? {}) as Ecosystem[],
    );
    const hasData = ecosystems.some((e) => withData.has(e)) || importers.size > 0;
    const shown = isTool(tech)
      ? true
      : importers.size > 0 || file !== undefined || (declared !== undefined && !hasData);
    const evidence = declared ?? file ?? [...importers].sort()[0];
    if (!shown || evidence === undefined) return [];
    return [
      {
        tech,
        use: {
          id: tech.id,
          evidence: { path: evidence },
          importingFiles: hasData ? importers.size : null,
        },
      },
    ];
  });
  technologies.sort(
    (a, b) =>
      (b.use.importingFiles ?? 0) - (a.use.importingFiles ?? 0) ||
      kindRank(a.tech) - kindRank(b.tech) ||
      a.tech.name.localeCompare(b.tech.name),
  );
  return { technologies: technologies.slice(0, MAX_TECHNOLOGIES).map((t) => t.use), unparsed };
}
