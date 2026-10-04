import type { Node } from "web-tree-sitter";
import type { SourceLanguage } from "./languages.ts";

/** An import as written in the source, before resolution to a file. */
export type RawImport =
  | { kind: "python"; module: string; level: number; names: string[]; line: number }
  | { kind: "es"; specifier: string; line: number };

export function extractImports(language: SourceLanguage, root: Node): RawImport[] {
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
