import type { Node } from "web-tree-sitter";
import { hasSyntaxError, type SourceLanguage, type SourceParser } from "./languages.ts";

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

/**
 * Top-level definitions plus class members; bodies of functions are not descended into.
 * A top-level statement with a syntax error can swallow the declarations after it, so its text
 * is split at column-0 declaration starts and each chunk is re-parsed alone (see `recover`).
 */
export function extractSymbols(
  language: SourceLanguage,
  root: Node,
  parser: SourceParser,
): SymbolDef[] {
  const out: SymbolDef[] = [];
  for (const child of root.namedChildren) {
    const chunks = hasSyntaxError(child) ? splitAtDeclarations(language, child) : [];
    if (chunks.length > 1) recover(language, parser, chunks, child.startPosition.column, out);
    else collectStatements(language, [child], out);
  }
  // Plain code-unit comparison: the order must not depend on the machine's locale.
  return mergeDuplicates(out).sort(
    (a, b) =>
      a.startLine - b.startLine ||
      (a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0),
  );
}

function collectStatements(language: SourceLanguage, statements: Node[], out: SymbolDef[]): void {
  if (language === "python") collectPython(statements, null, out);
  else collectTypeScript(statements, out);
}

/** A column-0 line where a top-level declaration can start. */
const DECLARATION_START = {
  python: /^(?:@|(?:async\s+)?def\b|class\b|[A-Za-z_]\w*\s*(?::.*)?=(?!=))/,
  typescript:
    /^(?:@|(?:export|declare|async|function|class|abstract|interface|type|enum|const|let|var)\b)/,
};

interface Chunk {
  text: string;
  /** 0-based row of the chunk's first line in the file. */
  row: number;
}

/**
 * Splits a statement's text before each column-0 declaration start after its first line. A
 * decorator stays with the declaration it decorates: no split until that declaration's line.
 */
function splitAtDeclarations(language: SourceLanguage, node: Node): Chunk[] {
  const start = DECLARATION_START[language === "python" ? "python" : "typescript"];
  const lines = node.text.split("\n");
  const chunks: Chunk[] = [];
  let first = 0;
  let decorated = false;
  lines.forEach((line, i) => {
    if (!start.test(line)) return;
    if (i > 0 && !decorated) {
      chunks.push({ text: lines.slice(first, i).join("\n"), row: node.startPosition.row + first });
      first = i;
    }
    decorated = line.startsWith("@");
  });
  chunks.push({ text: lines.slice(first).join("\n"), row: node.startPosition.row + first });
  return chunks;
}

/**
 * Symbols from re-parsed chunks. Only an error-free chunk is trusted in full: a chunk can start
 * inside a string or a broken body, and tree-sitter mangles what follows an error. The first
 * chunk starts where the full parse put a statement; at column 0 that statement is top-level, so
 * its declaration is kept even with the error inside it, as an unsplit statement's would be.
 */
function recover(
  language: SourceLanguage,
  parser: SourceParser,
  chunks: Chunk[],
  column: number,
  out: SymbolDef[],
): void {
  chunks.forEach((chunk, i) => {
    const parsed = parser.parse(language, chunk.text);
    try {
      const head = i === 0 && column === 0 ? parsed.root.namedChildren.slice(0, 1) : [];
      const found: SymbolDef[] = [];
      collectStatements(language, parsed.hasError ? head : parsed.root.namedChildren, found);
      for (const s of found)
        out.push({ ...s, startLine: s.startLine + chunk.row, endLine: s.endLine + chunk.row });
    } finally {
      parsed.dispose();
    }
  });
}

/**
 * One symbol per name: a getter/setter pair or a conditional redefinition becomes one span.
 * Same-name symbols of different kinds (`type Foo` + `const Foo`) also merge, keeping the first-seen kind.
 */
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

/** Public in Python: no leading underscore, or a `__dunder__` name (public protocol). */
function isPublicPythonName(name: string): boolean {
  return !name.startsWith("_") || (name.length > 4 && name.startsWith("__") && name.endsWith("__"));
}

function collectPython(statements: Node[], owner: string | null, out: SymbolDef[]): void {
  for (const child of statements) {
    if (child.type === "expression_statement") {
      // Module-level public bindings: `router = APIRouter()`, `MAX_RETRIES = 3`.
      if (owner !== null) continue;
      for (const assignment of child.namedChildren) {
        const target =
          assignment.type === "assignment" ? assignment.childForFieldName("left") : null;
        if (target?.type === "identifier" && isPublicPythonName(target.text)) {
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
    const exported = isPublicPythonName(name);
    if (definition.type === "function_definition") {
      out.push(symbol(qualifiedName, owner === null ? "function" : "method", child, exported));
    } else if (definition.type === "class_definition") {
      out.push(symbol(qualifiedName, "class", child, exported));
      const body = definition.childForFieldName("body");
      if (body) collectPython(body.namedChildren, qualifiedName, out);
    }
  }
}

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "generator_function"]);

function collectTypeScript(statements: Node[], out: SymbolDef[]): void {
  for (const child of statements) {
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
