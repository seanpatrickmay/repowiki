import type { Node } from "web-tree-sitter";
import type { SourceLanguage } from "./languages.ts";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "variable"
  | "interface"
  | "type"
  | "enum";

export interface SymbolDef {
  /** Dotted path inside the file: "K.m" for a method m of class K. */
  qualifiedName: string;
  kind: SymbolKind;
  /** 1-based inclusive line span, including decorators and an `export` keyword. */
  startLine: number;
  endLine: number;
  exported: boolean;
}

function symbol(qualifiedName: string, kind: SymbolKind, span: Node, exported: boolean): SymbolDef {
  return {
    qualifiedName,
    kind,
    startLine: span.startPosition.row + 1,
    endLine: span.endPosition.row + 1,
    exported,
  };
}

/** Top-level definitions plus class members; bodies of functions are not descended into. */
export function extractSymbols(language: SourceLanguage, root: Node): SymbolDef[] {
  const out: SymbolDef[] = [];
  if (language === "python") collectPython(root, null, out);
  else collectTypeScript(root, out);
  return mergeDuplicates(out).sort(
    (a, b) => a.startLine - b.startLine || a.qualifiedName.localeCompare(b.qualifiedName),
  );
}

/** One symbol per name: a getter/setter pair or a conditional redefinition becomes one span. */
function mergeDuplicates(symbols: SymbolDef[]): SymbolDef[] {
  const byName = new Map<string, SymbolDef>();
  for (const next of symbols) {
    const seen = byName.get(next.qualifiedName);
    if (seen === undefined) {
      byName.set(next.qualifiedName, { ...next });
      continue;
    }
    seen.startLine = Math.min(seen.startLine, next.startLine);
    seen.endLine = Math.max(seen.endLine, next.endLine);
    seen.exported ||= next.exported;
  }
  return [...byName.values()];
}

function collectPython(container: Node, owner: string | null, out: SymbolDef[]): void {
  for (const child of container.namedChildren) {
    if (child.type === "expression_statement") {
      // Module-level public bindings: `router = APIRouter()`, `MAX_RETRIES = 3`.
      if (owner !== null) continue;
      for (const assignment of child.namedChildren) {
        const target =
          assignment.type === "assignment" ? assignment.childForFieldName("left") : null;
        if (target?.type === "identifier" && !target.text.startsWith("_")) {
          out.push(symbol(target.text, "variable", child, true));
        }
      }
      continue;
    }
    const definition =
      child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
    const name = definition?.childForFieldName("name")?.text;
    if (!definition || !name) continue;
    const qualifiedName = owner === null ? name : `${owner}.${name}`;
    const exported = !name.startsWith("_");
    if (definition.type === "function_definition") {
      out.push(symbol(qualifiedName, owner === null ? "function" : "method", child, exported));
    } else if (definition.type === "class_definition") {
      out.push(symbol(qualifiedName, "class", child, exported));
      const body = definition.childForFieldName("body");
      if (body) collectPython(body, qualifiedName, out);
    }
  }
}

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "generator_function"]);

function collectTypeScript(root: Node, out: SymbolDef[]): void {
  for (const child of root.namedChildren) {
    if (child.type !== "export_statement") {
      collectDeclaration(child, child, false, out);
      continue;
    }
    const declaration = child.childForFieldName("declaration");
    if (declaration) {
      collectDeclaration(declaration, child, true, out);
      continue;
    }
    const value = child.childForFieldName("value");
    if (value && FUNCTION_VALUES.has(value.type))
      out.push(symbol("default", "function", child, true));
    else if (value?.type === "class") out.push(symbol("default", "class", child, true));
  }
}

function collectDeclaration(
  declaration: Node,
  span: Node,
  exported: boolean,
  out: SymbolDef[],
): void {
  const name = declaration.childForFieldName("name")?.text;
  switch (declaration.type) {
    case "function_declaration":
    case "generator_function_declaration":
      if (name) out.push(symbol(name, "function", span, exported));
      return;
    case "class_declaration":
    case "abstract_class_declaration": {
      if (!name) return;
      out.push(symbol(name, "class", span, exported));
      const body = declaration.childForFieldName("body");
      for (const member of body ? body.namedChildren : []) {
        if (member.type !== "method_definition" && member.type !== "abstract_method_signature")
          continue;
        const method = member.childForFieldName("name")?.text;
        if (method) out.push(symbol(`${name}.${method}`, "method", member, exported));
      }
      return;
    }
    case "interface_declaration":
      if (name) out.push(symbol(name, "interface", span, exported));
      return;
    case "type_alias_declaration":
      if (name) out.push(symbol(name, "type", span, exported));
      return;
    case "enum_declaration":
      if (name) out.push(symbol(name, "enum", span, exported));
      return;
    case "lexical_declaration":
    case "variable_declaration":
      for (const declarator of declaration.namedChildren) {
        if (declarator.type !== "variable_declarator") continue;
        const id = declarator.childForFieldName("name");
        const value = declarator.childForFieldName("value");
        if (id?.type !== "identifier") continue;
        if (value && FUNCTION_VALUES.has(value.type))
          out.push(symbol(id.text, "function", span, exported));
        else if (exported) out.push(symbol(id.text, "variable", span, true));
      }
      return;
  }
}
