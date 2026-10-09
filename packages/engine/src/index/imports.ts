import type { Node } from "web-tree-sitter";
import type { SourceLanguage } from "./languages.ts";

/**
 * An import as written in the source, before resolution to a file. A Rust `use` is one path per
 * name it brings in (a list, a glob or an alias still names one path each); `mod name;` is a
 * module file, at `file` when it has a `#[path = "file"]`. `scope` holds the inline modules
 * around either, outermost first.
 */
export type RawImport =
  | { kind: "python"; module: string; level: number; names: string[]; line: number }
  | { kind: "es"; specifier: string; line: number }
  | { kind: "rust-use"; path: string[]; scope: string[]; line: number }
  | { kind: "rust-mod"; name: string; scope: string[]; file: string | null; line: number };

export function extractImports(language: SourceLanguage, root: Node): RawImport[] {
  if (language === "rust") return rustImports(root).map(({ raw }) => raw);
  return language === "python" ? pythonImports(root) : esImports(root);
}

function dottedText(node: Node): string | null {
  if (node.type === "dotted_name") return node.text;
  if (node.type === "aliased_import") return node.childForFieldName("name")?.text ?? null;
  return null;
}

function pythonImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  for (const node of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    // Error recovery can splice tokens from a later line into a node; report only clean ones.
    if (node.hasError) continue;
    const line = node.startPosition.row + 1;
    const names = node
      .childrenForFieldName("name")
      .map(dottedText)
      .filter((name): name is string => name !== null);
    if (node.type === "import_statement") {
      for (const module of names) out.push({ kind: "python", module, level: 0, names: [], line });
      continue;
    }
    const moduleNode = node.childForFieldName("module_name");
    if (moduleNode === null) continue;
    if (moduleNode.type === "relative_import") {
      const prefix = moduleNode.namedChildren.find((n) => n.type === "import_prefix")?.text ?? "";
      const dotted = moduleNode.namedChildren.find((n) => n.type === "dotted_name")?.text ?? "";
      out.push({ kind: "python", module: dotted, level: prefix.length, names, line });
    } else {
      out.push({ kind: "python", module: moduleNode.text, level: 0, names, line });
    }
  }
  return out;
}

function stringValue(node: Node | null): string | null {
  if (node?.type !== "string") return null;
  return node.namedChildren.find((n) => n.type === "string_fragment")?.text ?? "";
}

function esImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  for (const node of root.descendantsOfType([
    "import_statement",
    "export_statement",
    "call_expression",
  ])) {
    if (node.hasError) continue;
    let specifier: string | null = null;
    if (node.type === "call_expression") {
      if (node.childForFieldName("function")?.type !== "import") continue;
      const args = node.childForFieldName("arguments");
      specifier = stringValue(args?.namedChildren[0] ?? null);
    } else {
      specifier = stringValue(node.childForFieldName("source"));
    }
    if (specifier) out.push({ kind: "es", specifier, line: node.startPosition.row + 1 });
  }
  return out;
}

/** The inline modules around a node, outermost first. */
function rustScope(node: Node): string[] {
  const scope: string[] = [];
  for (let at = node.parent; at !== null; at = at.parent) {
    const name = at.type === "mod_item" ? at.childForFieldName("name")?.text : undefined;
    if (name !== undefined) scope.unshift(name);
  }
  return scope;
}

function pathSegments(node: Node | null): string[] {
  if (node === null) return [];
  if (node.type !== "scoped_identifier") return [node.text];
  return [
    ...pathSegments(node.childForFieldName("path")),
    ...pathSegments(node.childForFieldName("name")),
  ];
}

/** `prefix` then `segments`; a leading `self` in a list (`a::{self, b}`) names the prefix itself. */
const extend = (prefix: string[], segments: string[]): string[] =>
  prefix.length > 0 && segments[0] === "self"
    ? [...prefix, ...segments.slice(1)]
    : [...prefix, ...segments];

/** The paths of a use tree, each with the name it binds (null for a glob). */
function useTree(node: Node, prefix: string[]): { path: string[]; local: string | null }[] {
  const path = extend(prefix, pathSegments(node.childForFieldName("path")));
  switch (node.type) {
    case "use_as_clause":
      return [{ path, local: node.childForFieldName("alias")?.text ?? null }];
    case "use_wildcard":
      return [{ path: extend(prefix, pathSegments(node.namedChildren[0] ?? null)), local: null }];
    case "use_list":
      return node.namedChildren.flatMap((item) => useTree(item, prefix));
    case "scoped_use_list": {
      const list = node.childForFieldName("list");
      return list === null ? [] : useTree(list, path);
    }
    default: {
      const full = extend(prefix, pathSegments(node));
      return [{ path: full, local: full.at(-1) ?? null }];
    }
  }
}

/** Each Rust `use` path and `mod name;` with the name it binds in the file (null for a glob). */
export function rustImports(root: Node): { raw: RawImport; local: string | null }[] {
  const out: { raw: RawImport; local: string | null }[] = [];
  for (const node of root.descendantsOfType(["use_declaration", "mod_item"])) {
    if (node.hasError) continue;
    const line = node.startPosition.row + 1;
    const scope = rustScope(node);
    if (node.type === "use_declaration") {
      const argument = node.childForFieldName("argument");
      for (const { path, local } of argument === null ? [] : useTree(argument, [])) {
        out.push({ raw: { kind: "rust-use", path, scope, line }, local });
      }
      continue;
    }
    const name = node.childForFieldName("name")?.text;
    if (name === undefined || node.childForFieldName("body") !== null) continue;
    let file: string | null = null;
    for (
      let at = node.previousNamedSibling;
      at?.type === "attribute_item";
      at = at.previousNamedSibling
    )
      file ??= /^#\[\s*path\s*=\s*"([^"]+)"\s*\]$/.exec(at.text)?.[1] ?? null;
    out.push({ raw: { kind: "rust-mod", name, scope, file, line }, local: name });
  }
  return out;
}
