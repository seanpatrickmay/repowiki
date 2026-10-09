import { posix } from "node:path";

/** What resolving Rust imports needs from one tracked Cargo.toml. */
export interface CargoManifest {
  /** Repo-relative directory of the manifest; "" at the repo root. */
  dir: string;
  /** `[package] name` with `-` as `_`, the name other crates `use` it by; null if unread. */
  crate: string | null;
  /** True unless the manifest is only a `[workspace]`. */
  package: boolean;
  /** `[lib] path` and each `[[bin]] path`, repo-relative. */
  lib: string | null;
  bins: string[];
  /** `[workspace] members` as repo-relative globs; null when the manifest has none. */
  members: string[] | null;
}

type TomlValue = string | string[];

/**
 * The string and string-array values of a TOML text by `table.key` ("bin.path" once per `[[bin]]`),
 * and the tables seen. Only what Cargo.toml's keys above need: bare keys, `[table]` and
 * `[[table]]` headers, basic and literal strings, arrays of them over several lines, comments.
 * Anything else is skipped to the end of its line. It never throws.
 */
function readToml(text: string): { values: Map<string, TomlValue[]>; tables: Set<string> } {
  const values = new Map<string, TomlValue[]>();
  const tables = new Set<string>();
  let table = "";
  let i = 0;
  const at = () => text[i] ?? "";
  const skip = (chars: string) => {
    while (i < text.length && chars.includes(at())) i++;
  };
  const toLineEnd = () => {
    const end = text.indexOf("\n", i);
    i = end === -1 ? text.length : end + 1;
  };
  const string = (): string | null => {
    const quote = at();
    const triple = quote.repeat(3);
    if (text.startsWith(triple, i)) {
      const end = text.indexOf(triple, i + 3);
      i = end === -1 ? text.length : end + 3;
      return null; // A multi-line string holds no key read here.
    }
    let value = "";
    for (i++; i < text.length && at() !== quote && at() !== "\n"; i++) {
      if (quote === '"' && at() === "\\") i++;
      value += at();
    }
    if (at() !== quote) return null;
    i++;
    return value;
  };
  const value = (): TomlValue | null => {
    if (at() === '"' || at() === "'") return string();
    if (at() !== "[") return null;
    const items: string[] = [];
    for (i++; i < text.length; ) {
      skip(" \t\r\n,");
      if (at() === "#") toLineEnd();
      else if (at() === "]") {
        i++;
        return items;
      } else {
        const item = at() === '"' || at() === "'" ? string() : null;
        if (item === null) return null;
        items.push(item);
      }
    }
    return null;
  };
  const KEY = /([A-Za-z0-9_-]+)[ \t]*=[ \t]*/y;
  while (i < text.length) {
    skip(" \t\r\n");
    const end = text.indexOf("]", i);
    const eol = text.indexOf("\n", i);
    if (at() === "[" && end !== -1 && (eol === -1 || end < eol)) {
      table = text.slice(i, end).replace(/^\[+|\s+/g, "");
      tables.add(table);
    } else {
      KEY.lastIndex = i;
      const key = KEY.exec(text);
      if (key !== null) {
        i += key[0].length;
        const found = value();
        const name = `${table}.${key[1]}`;
        if (found !== null) values.set(name, [...(values.get(name) ?? []), found]);
      }
    }
    toLineEnd();
  }
  return { values, tables };
}

/** Reads a tracked Cargo.toml. A malformed one reads as a nameless package (src/lib.rs, src/main.rs). */
export function parseCargoManifest(path: string, text: string): CargoManifest {
  const { values, tables } = readToml(text);
  const strings = (key: string) =>
    (values.get(key) ?? []).filter((v): v is string => typeof v === "string");
  const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
  const inDir = (p: string) => posix.normalize(posix.join(dir, p));
  const name = strings("package.name")[0];
  const lib = strings("lib.path")[0];
  const members = values.get("workspace.members")?.find((v) => Array.isArray(v));
  return {
    dir,
    crate: name === undefined ? null : name.replaceAll("-", "_"),
    package: tables.has("package") || !tables.has("workspace"),
    lib: lib === undefined ? null : inDir(lib),
    bins: strings("bin.path").map(inDir),
    members: members === undefined ? null : members.map(inDir),
  };
}
