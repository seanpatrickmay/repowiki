import type { Node } from "web-tree-sitter";
import type { RawImport } from "./imports.ts";
import type { SourceLanguage } from "./languages.ts";

/**
 * A name an import statement binds in a file. `imported` is the name exported by the target
 * ("default" for an ES default import), or null when the binding is the module itself
 * (`import * as ns`, `import a.b as ns`). `raw` is the statement, for resolving its target file.
 */
export interface ImportBinding {
  local: string;
  imported: string | null;
  raw: RawImport;
}

/**
 * A call (or `new`, or a JSX element) as written: `name(...)`, `receiver.name(...)`, or a call on
 * the instance, which has the receiver "self": `self.`/`cls.` in Python, `this.` in TS and TSX
 * (a TS variable named `self` or `cls` keeps its own name).
 *
 * Only a plain-identifier receiver is recorded. A call on anything else (a chain `a.b().c()`,
 * `this.a.b()`, `a!.b()`, `super.m()`, `a.b.c()`) records only what it records today: the
 * inner call of a chain, and nothing for the outer call.
 */
export interface CallSite {
  name: string;
  receiver: string | null;
  line: number;
}

const lineOf = (node: Node): number => node.startPosition.row + 1;

export function extractBindings(language: SourceLanguage, root: Node): ImportBinding[] {
  return language === "python" ? pythonBindings(root) : esBindings(root);
}

function pythonBindings(root: Node): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const node of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (node.hasError) continue;
    const line = lineOf(node);
    if (node.type === "import_statement") {
      for (const name of node.childrenForFieldName("name")) {
        const module = name.type === "aliased_import" ? name.childForFieldName("name") : name;
        const alias = name.type === "aliased_import" ? name.childForFieldName("alias") : null;
        if (module === null) continue;
        // `import a.b` binds only `a`, whose attributes RepoWiki does not follow.
        if (alias === null && module.text.includes(".")) continue;
        const raw: RawImport = { kind: "python", module: module.text, level: 0, names: [], line };
        out.push({ local: alias?.text ?? module.text, imported: null, raw });
      }
      continue;
    }
    const moduleNode = node.childForFieldName("module_name");
    if (moduleNode === null) continue;
    let module = moduleNode.text;
    let level = 0;
    if (moduleNode.type === "relative_import") {
      level = moduleNode.namedChildren.find((n) => n.type === "import_prefix")?.text.length ?? 0;
      module = moduleNode.namedChildren.find((n) => n.type === "dotted_name")?.text ?? "";
    }
    for (const name of node.childrenForFieldName("name")) {
      const imported = name.type === "aliased_import" ? name.childForFieldName("name") : name;
      const alias = name.type === "aliased_import" ? name.childForFieldName("alias") : null;
      if (imported === null || imported.text.includes(".")) continue;
      const raw: RawImport = { kind: "python", module, level, names: [imported.text], line };
      out.push({ local: alias?.text ?? imported.text, imported: imported.text, raw });
    }
  }
  return out;
}

function esBindings(root: Node): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const node of root.descendantsOfType("import_statement")) {
    if (node.hasError) continue;
    const specifier = node
      .childForFieldName("source")
      ?.namedChildren.find((n) => n.type === "string_fragment")?.text;
    const clause = node.namedChildren.find((n) => n.type === "import_clause");
    if (!specifier || clause === undefined) continue;
    const raw: RawImport = { kind: "es", specifier, line: lineOf(node) };
    for (const part of clause.namedChildren) {
      if (part.type === "identifier") out.push({ local: part.text, imported: "default", raw });
      else if (part.type === "namespace_import") {
        const local = part.namedChildren.find((n) => n.type === "identifier")?.text;
        if (local) out.push({ local, imported: null, raw });
      } else if (part.type === "named_imports") {
        for (const spec of part.namedChildren) {
          if (spec.type !== "import_specifier") continue;
          const name = spec.childForFieldName("name")?.text;
          const alias = spec.childForFieldName("alias")?.text;
          if (name) out.push({ local: alias ?? name, imported: name, raw });
        }
      }
    }
  }
  return out;
}

/** Every call site in the file, function bodies included, in source order without repeats. */
export function extractCalls(language: SourceLanguage, root: Node): CallSite[] {
  const found = new Map<string, CallSite>();
  const add = (callee: Node | null, line: number): void => {
    const site = callee === null ? null : calleeOf(language, callee);
    if (site === null) return;
    found.set(`${site.receiver ?? ""}\0${site.name}\0${line}`, { ...site, line });
  };
  if (language === "python") {
    for (const call of root.descendantsOfType("call")) {
      if (!call.hasError) add(call.childForFieldName("function"), lineOf(call));
    }
  } else {
    const types = ["call_expression", "new_expression"];
    if (language === "tsx") types.push("jsx_opening_element", "jsx_self_closing_element");
    for (const node of root.descendantsOfType(types)) {
      if (node.hasError) continue;
      const callee =
        node.type === "call_expression"
          ? node.childForFieldName("function")
          : node.type === "new_expression"
            ? node.childForFieldName("constructor")
            : node.childForFieldName("name");
      // Lowercase JSX tags (<div>) are HTML elements, not components.
      if (node.type.startsWith("jsx_") && callee?.type === "identifier") {
        if (!/^[A-Z]/.test(callee.text)) continue;
      }
      add(callee, lineOf(node));
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

function calleeOf(
  language: SourceLanguage,
  node: Node,
): { name: string; receiver: string | null } | null {
  if (node.type === "identifier") return { name: node.text, receiver: null };
  if (node.type !== "attribute" && node.type !== "member_expression") return null;
  const object = node.childForFieldName("object");
  const name = node.childForFieldName(node.type === "attribute" ? "attribute" : "property");
  if (object === null || name === null) return null;
  // In a TSX member tag (`<this.X />`) the grammar gives `this` as an identifier.
  const isSelf =
    language === "python"
      ? object.type === "identifier" && /^(self|cls)$/.test(object.text)
      : object.type === "this" || (object.type === "identifier" && object.text === "this");
  if (isSelf) return { name: name.text, receiver: "self" };
  return object.type === "identifier" ? { name: name.text, receiver: object.text } : null;
}
