import type { Ecosystem } from "./technologies.ts";
import { type TomlTable, type TomlValue, tomlTables } from "./toml.ts";

/**
 * Small hand-written readers for dependency manifests and compose files (ADR-0014): enough of
 * JSON, TOML, requirement lines, go.mod and YAML to list what a file declares, and nothing more.
 * A file that will not parse reads as null; nothing here throws on its input.
 */

export type ManifestKind =
  | "package.json"
  | "pyproject"
  | "requirements"
  | "cargo"
  | "go.mod"
  | "pipfile"
  | "compose";

export interface Declared {
  ecosystem: Ecosystem;
  name: string;
}
export interface ManifestRead {
  declared: Declared[];
  /** Compose `image:` values as written (`postgres:16-alpine`). */
  images: string[];
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Which reader a path needs, or null when detection never reads its contents. */
export function manifestKind(path: string): ManifestKind | null {
  const name = basename(path);
  if (name === "package.json") return "package.json";
  if (name === "pyproject.toml") return "pyproject";
  if (/^requirements[^/]*\.txt$/.test(name)) return "requirements";
  if (name === "Cargo.toml") return "cargo";
  if (name === "go.mod") return "go.mod";
  if (name === "Pipfile") return "pipfile";
  if (/^(?:docker-)?compose[^/]*\.ya?ml$/.test(name)) return "compose";
  return null;
}

/** The project name a PEP 508 requirement starts with. */
const PEP508 = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;
const requirementName = (spec: string) => PEP508.exec(spec)?.[1] ?? null;
const strings = (v: TomlValue) =>
  v.kind === "array" ? v.items.flatMap((item) => (item.kind === "string" ? [item.value] : [])) : [];

/** Whether `full` starts with `prefix`, where "*" matches any one segment. */
const startsWith = (full: readonly string[], prefix: readonly string[]) =>
  full.length >= prefix.length && prefix.every((p, n) => p === "*" || full[n] === p);

/** Sections whose values are requirement lists (PEP 621, PEP 735, PEP 518, uv). */
const REQUIREMENT_LISTS = [
  ["build-system", "requires"],
  ["project", "dependencies"],
  ["project", "optional-dependencies", "*"],
  ["dependency-groups", "*"],
  ["tool", "uv", "dev-dependencies"],
];
/** Sections whose keys are package names (Poetry). */
const POETRY_TABLES = [
  ["tool", "poetry", "dependencies"],
  ["tool", "poetry", "dev-dependencies"],
  ["tool", "poetry", "group", "*", "dependencies"],
];

function pyproject(tables: readonly TomlTable[]): string[] {
  const out: string[] = [];
  for (const table of tables) {
    // A [tool.poetry] table is Poetry itself.
    if (startsWith(table.path, ["tool", "poetry"])) out.push("poetry");
    for (const { key, value } of table.entries) {
      const full = [...table.path, ...key];
      if (REQUIREMENT_LISTS.some((p) => p.length === full.length && startsWith(full, p))) {
        out.push(...strings(value).flatMap((s) => requirementName(s) ?? []));
        continue;
      }
      const section = POETRY_TABLES.find((p) => full.length > p.length && startsWith(full, p));
      const name = section === undefined ? undefined : full[section.length];
      if (name !== undefined && name !== "python") out.push(name);
    }
  }
  return out;
}

const CARGO_SECTIONS = new Set(["dependencies", "dev-dependencies", "build-dependencies"]);

/** The crate a Cargo key path names: `[dependencies] x`, `[target.*.dependencies] x`, `[dependencies.x]`. */
function crateOf(full: readonly string[]): string | undefined {
  const j = full.findIndex((s) => CARGO_SECTIONS.has(s));
  if (j === -1 || !(j === 0 || full[0] === "workspace" || full[0] === "target")) return undefined;
  return full[j + 1];
}

function cargo(tables: readonly TomlTable[]): string[] {
  return tables.flatMap((table) =>
    [table.path, ...table.entries.map(({ key }) => [...table.path, ...key])].flatMap(
      (full) => crateOf(full) ?? [],
    ),
  );
}

const pipfile = (tables: readonly TomlTable[]) =>
  tables
    .filter(
      (t) => t.path.length === 1 && (t.path[0] === "packages" || t.path[0] === "dev-packages"),
    )
    .flatMap((t) => t.entries.flatMap((e) => e.key[0] ?? []));

function requirements(text: string): string[] {
  return text.split(/\r?\n/).flatMap((raw) => {
    const line = raw
      .replace(/(?:^|\s)#.*$/, "")
      .replace(/\\$/, "")
      .trim();
    // Options (-r, -e, --hash), URLs and local paths name no project.
    if (line === "" || line.startsWith("-") || /^[a-z+]+:\/\//i.test(line) || /^[./~]/.test(line)) {
      return [];
    }
    return requirementName(line) ?? [];
  });
}

/** `require` lines and blocks, skipping `// indirect` ones; null for an unclosed block. */
function goMod(text: string): string[] | null {
  const out: string[] = [];
  let block = false;
  for (const raw of text.split(/\r?\n/)) {
    const indirect = /\/\/\s*indirect\b/.test(raw);
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (block) {
      if (line === ")") block = false;
      else if (line !== "" && !indirect) out.push(line.split(/\s+/)[0] ?? "");
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      block = true;
      continue;
    }
    const single = /^require\s+(\S+)\s+\S+/.exec(line);
    if (single?.[1] !== undefined && !indirect) out.push(single[1]);
  }
  return block ? null : out;
}

/** Compose `image:` values; null when one has an unclosed quote. */
function composeImages(text: string): string[] | null {
  const images: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:-\s+)?image:\s*(.*)$/.exec(raw);
    if (match?.[1] === undefined) continue;
    let image = match[1].trim();
    const quote = image[0];
    if (quote === '"' || quote === "'") {
      const end = image.indexOf(quote, 1);
      if (end === -1) return null;
      image = image.slice(1, end);
    } else {
      image = image.replace(/\s+#.*$/, "").trim();
    }
    if (image !== "") images.push(image);
  }
  return images;
}

function packageJson(text: string): string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return ["dependencies", "devDependencies", "peerDependencies"].flatMap((section) => {
    const deps = record[section];
    return typeof deps === "object" && deps !== null && !Array.isArray(deps)
      ? Object.keys(deps)
      : [];
  });
}

const ECOSYSTEM: Record<Exclude<ManifestKind, "compose">, Ecosystem> = {
  "package.json": "npm",
  pyproject: "pypi",
  requirements: "pypi",
  pipfile: "pypi",
  cargo: "crates",
  "go.mod": "go",
};
/** npm's own limit on a package name; longer text is not a name. */
const MAX_NAME = 214;

/**
 * What the file at `path` declares: packages for a manifest, images for a compose file, nothing
 * for any other path. Null when the file will not parse.
 */
export function readManifest(path: string, text: string): ManifestRead | null {
  const kind = manifestKind(path);
  if (kind === null) return { declared: [], images: [] };
  if (text.includes("\u0000")) return null;
  if (kind === "compose") {
    const images = composeImages(text);
    return images === null ? null : { declared: [], images };
  }
  const toml = kind === "pyproject" || kind === "cargo" || kind === "pipfile";
  const tables = toml ? tomlTables(text) : [];
  if (tables === null) return null;
  const names =
    kind === "package.json"
      ? packageJson(text)
      : kind === "requirements"
        ? requirements(text)
        : kind === "go.mod"
          ? goMod(text)
          : kind === "pyproject"
            ? pyproject(tables)
            : kind === "cargo"
              ? cargo(tables)
              : pipfile(tables);
  if (names === null) return null;
  const ecosystem = ECOSYSTEM[kind];
  const kept = [...new Set(names)].filter((n) => n !== "" && n.length <= MAX_NAME);
  return { declared: kept.map((name) => ({ ecosystem, name })), images: [] };
}
