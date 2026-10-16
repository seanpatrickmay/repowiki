/**
 * The subset of TOML that dependency manifests use (ADR-0014): table headers, `key = value`,
 * strings, multi-line arrays, and inline tables read for their keys only. Hand-written so that
 * reading a manifest needs no dependency; malformed input reads as null, never a throw.
 */
export type TomlValue =
  | { kind: "string"; value: string }
  | { kind: "array"; items: TomlValue[] }
  | { kind: "table"; keys: string[][] }
  | { kind: "other" };
export interface TomlTable {
  /** The header's dotted path; `[]` for the keys before the first header. */
  path: string[];
  entries: { key: string[]; value: TomlValue }[];
}

class TomlError extends Error {}
const BARE_KEY = /[A-Za-z0-9_-]+/y;
const BARE_VALUE = /[^\s,\]}#]+/y;
/** The time of a date-time written with a space (`1979-05-27 07:32:00Z`). */
const SPACED_TIME = / \d{2}:\d{2}[^\s,\]}#]*/y;
/** Arrays and inline tables nest at most this deep; manifests never come close (review I1). */
const MAX_DEPTH = 64;

/** The subset of TOML that manifests use; inline tables keep only their keys. */
function parseToml(text: string): TomlTable[] {
  let i = 0;
  const fail = (): never => {
    throw new TomlError();
  };
  const at = (s: string) => text.startsWith(s, i);
  const skipSpace = () => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  const skipComment = () => {
    if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
  };
  /** Spaces, comments and line breaks, as between an array's items. */
  const skipAll = () => {
    for (;;) {
      skipSpace();
      skipComment();
      if (text[i] !== "\n" && text[i] !== "\r") return;
      i++;
    }
  };
  const endOfLine = () => {
    skipSpace();
    skipComment();
    if (i < text.length && text[i] !== "\n" && text[i] !== "\r") fail();
  };
  const string = (): string => {
    const triple = at('"""') ? '"""' : at("'''") ? "'''" : null;
    if (triple !== null) {
      const end = text.indexOf(triple, i + 3);
      if (end === -1) fail();
      const value = text.slice(i + 3, end);
      i = end + 3;
      return value;
    }
    const quote = text[i];
    i++;
    let out = "";
    while (i < text.length && text[i] !== quote) {
      if (text[i] === "\n") fail();
      if (quote === '"' && text[i] === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      out += text[i];
      i++;
    }
    if (i >= text.length) fail();
    i++;
    return out;
  };
  const sticky = (re: RegExp): string => {
    re.lastIndex = i;
    const match = re.exec(text);
    if (match === null) return fail();
    i += match[0].length;
    return match[0];
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpace();
      parts.push(text[i] === '"' || text[i] === "'" ? string() : sticky(BARE_KEY));
      skipSpace();
      if (text[i] !== ".") return parts;
      i++;
    }
  };
  const value = (depth = 0): TomlValue => {
    if (depth > MAX_DEPTH) fail();
    if (text[i] === '"' || text[i] === "'") return { kind: "string", value: string() };
    if (text[i] === "[") {
      i++;
      const items: TomlValue[] = [];
      for (;;) {
        skipAll();
        if (text[i] === "]") break;
        if (i >= text.length) fail();
        items.push(value(depth + 1));
        skipAll();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail();
      }
      i++;
      return { kind: "array", items };
    }
    if (text[i] === "{") {
      i++;
      const keys: string[][] = [];
      for (;;) {
        skipAll();
        if (text[i] === "}") break;
        keys.push(key());
        if (text[i] !== "=") fail();
        i++;
        skipSpace();
        value(depth + 1);
        skipAll();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail();
      }
      i++;
      return { kind: "table", keys };
    }
    const bare = sticky(BARE_VALUE);
    if (/^\d{4}-\d{2}-\d{2}$/.test(bare)) {
      SPACED_TIME.lastIndex = i;
      const time = SPACED_TIME.exec(text);
      if (time !== null) i += time[0].length;
    }
    return { kind: "other" };
  };

  const tables: TomlTable[] = [{ path: [], entries: [] }];
  for (;;) {
    skipAll();
    if (i >= text.length) return tables;
    if (text[i] === "[") {
      const close = at("[[") ? "]]" : "]";
      i += close.length;
      const path = key();
      if (!at(close)) fail();
      i += close.length;
      endOfLine();
      tables.push({ path, entries: [] });
      continue;
    }
    const k = key();
    if (text[i] !== "=") fail();
    i++;
    skipSpace();
    const v = value();
    endOfLine();
    tables.at(-1)?.entries.push({ key: k, value: v });
  }
}

/**
 * A TOML document's tables, or null when it is outside the subset, malformed, or breaks the
 * reader in any other way: a manifest never fails a job (review I1).
 */
export function tomlTables(text: string): TomlTable[] | null {
  try {
    return parseToml(text);
  } catch {
    return null;
  }
}
