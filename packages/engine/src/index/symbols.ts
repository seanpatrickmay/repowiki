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
 * Column 0 is the only sign of a top-level declaration inside a broken statement, so a local
 * written at column 0 in a broken TS body is taken as top-level unless a later stray `}` shows
 * otherwise.
 */
export function extractSymbols(
  language: SourceLanguage,
  root: Node,
  parser: SourceParser,
): SymbolDef[] {
  const out: SymbolDef[] = [];
  for (const child of root.namedChildren) {
    const chunks = hasSyntaxError(child) ? splitAtDeclarations(language, child) : [];
    if (chunks.length > 1) recover(language, parser, child, chunks, out);
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
  python: /^(?:@|(?:async\s+)?def\b|class\b)/,
  typescript:
    /^(?:@|(?:export|declare|async|function|class|abstract|interface|type|enum|const|let|var)\b)/,
};

/** A line that belongs to the declaration on the next start line: a decorator or a bare `export`. */
const ATTACHED = /^(?:@|export(?:\s+default)?\s*$)/;

interface Chunk {
  text: string;
  /** 0-based row of the chunk's first line in the file. */
  row: number;
}

/**
 * Rows that start inside a multi-line comment, string, template literal or JSX text. The full
 * parse keeps these nodes even inside an ERROR node, and a chunk must never start in one.
 */
function rowsInsideText(node: Node): Set<number> {
  const rows = new Set<number>();
  // Document order: a node nested in a text node comes after it and is covered by it, so each
  // row is added once and the walk stays linear however deeply templates nest.
  let covered = -1;
  for (const text of node.descendantsOfType(["comment", "string", "template_string", "jsx_text"])) {
    const last = text.endPosition.column > 0 ? text.endPosition.row : text.endPosition.row - 1;
    for (let row = Math.max(text.startPosition.row + 1, covered + 1); row <= last; row++)
      rows.add(row);
    covered = Math.max(covered, last);
  }
  return rows;
}

/**
 * Splits a statement's text before each column-0 declaration start after its first line. A
 * decorator or a bare `export` stays with its declaration: no split until that declaration's line.
 */
function splitAtDeclarations(language: SourceLanguage, node: Node): Chunk[] {
  const start = DECLARATION_START[language === "python" ? "python" : "typescript"];
  const inside = rowsInsideText(node);
  const row = node.startPosition.row;
  const lines = node.text.split("\n");
  const chunks: Chunk[] = [];
  let first = 0;
  let attached = false;
  lines.forEach((line, i) => {
    if (inside.has(row + i) || !start.test(line)) return;
    if (i > 0 && !attached) {
      chunks.push({ text: lines.slice(first, i).join("\n"), row: row + first });
      first = i;
    }
    attached = ATTACHED.test(line);
  });
  chunks.push({ text: lines.slice(first).join("\n"), row: row + first });
  return chunks;
}

/** True when a TS chunk closes more braces than it opens: what came before it was in a block. */
function closesOuterBlock(root: Node): boolean {
  let depth = 0;
  for (const brace of root.descendantsOfType(["{", "${", "}"]))
    if (!brace.isMissing) depth += brace.type === "}" ? -1 : 1;
  return depth < 0;
}

/** A column-0 namespace or module block start: an `export` in its body is not top-level. */
const NAMESPACE_START = /^(?:export\s+)?(?:declare\s+)?(?:namespace|module|global)\s*[\w"'{]/m;

/**
 * Symbols from re-parsed chunks. Only an error-free chunk is trusted: a chunk can start inside a
 * broken body, and tree-sitter mangles what follows an error. A broken first chunk keeps the full
 * parse's symbols for the statement, cut off at the chunk's last line. Non-exported symbols from
 * clean chunks before a TS chunk that closes an outer block were locals of that block; exported
 * ones were too if a namespace or module block was opened since the last such chunk.
 */
function recover(
  language: SourceLanguage,
  parser: SourceParser,
  statement: Node,
  chunks: Chunk[],
  out: SymbolDef[],
): void {
  let pending: SymbolDef[] = [];
  let namespaced = false;
  chunks.forEach((chunk, i) => {
    namespaced ||= language !== "python" && NAMESPACE_START.test(chunk.text);
    const parsed = parser.parse(language, chunk.text);
    try {
      if (!parsed.hasError) {
        const found: SymbolDef[] = [];
        collectStatements(language, parsed.root.namedChildren, found);
        const shifted = found.map((s) => ({
          ...s,
          startLine: s.startLine + chunk.row,
          endLine: s.endLine + chunk.row,
        }));
        (i === 0 ? out : pending).push(...shifted);
      } else if (i === 0) {
        const last = chunk.row + chunk.text.trimEnd().split("\n").length;
        const found: SymbolDef[] = [];
        collectStatements(language, [statement], found);
        for (const s of found)
          if (s.startLine <= last) out.push({ ...s, endLine: Math.min(s.endLine, last) });
      } else if (language !== "python" && closesOuterBlock(parsed.root)) {
        pending = namespaced ? [] : pending.filter((s) => s.exported);
        namespaced = false;
      }
    } finally {
      parsed.dispose();
    }
  });
  out.push(...pending);
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
