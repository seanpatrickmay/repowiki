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

/** An import binding whose target file is known. `imported` null: the binding is that module. */
export interface ResolvedBinding {
  local: string;
  imported: string | null;
  target: string;
}

/** A call from one indexed member to an indexed symbol, at the first line it happens. */
export interface CallEdge {
  /** memberId of the innermost symbol around the call, or of the file for module-level code. */
  from: string;
  /** memberId of the called symbol. */
  to: string;
  line: number;
}

/** What resolving calls needs to know about a file's symbols. */
export interface SymbolSpan {
  id: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
}

/**
 * Ties a binding to its resolved targets. A Python from-import that names a submodule binds that
 * module; otherwise the binding names a symbol of the first target. Null when nothing resolved.
 */
export function resolveBinding(
  binding: ImportBinding,
  targets: readonly string[],
): ResolvedBinding | null {
  const { local, imported } = binding;
  if (binding.raw.kind === "python" && imported !== null) {
    const submodule = targets.find(
      (t) =>
        t === `${imported}.py` ||
        t.endsWith(`/${imported}.py`) ||
        t.endsWith(`/${imported}/__init__.py`),
    );
    if (submodule !== undefined) return { local, imported: null, target: submodule };
  }
  const target = targets[0];
  return target === undefined ? null : { local, imported, target };
}

/**
 * Call edges out of one file, resolved by name only: an imported name, a module binding's
 * attribute, a top-level symbol of the same file, `self.m()` inside class K as K.m, or K.m() for a
 * class K of the same file. Calls on other objects cannot be resolved without types, so they are
 * left out. Self-edges are dropped; each (from, to) pair keeps its first line.
 */
export function resolveCalls(
  file: { id: string; path: string; symbols: readonly SymbolSpan[] },
  calls: readonly CallSite[],
  bindings: readonly ResolvedBinding[],
  symbolsOf: (path: string) => readonly SymbolSpan[],
): CallEdge[] {
  const find = (path: string, qualifiedName: string) =>
    symbolsOf(path).find((s) => s.qualifiedName === qualifiedName);
  const byLocal = new Map(bindings.map((b) => [b.local, b]));
  const enclosing = (line: number, kind?: string) =>
    file.symbols
      .filter(
        (s) => s.startLine <= line && line <= s.endLine && (kind === undefined || s.kind === kind),
      )
      .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];

  const callee = (call: CallSite): SymbolSpan | undefined => {
    if (call.receiver === "self") {
      const owner = enclosing(call.line, "class");
      return owner === undefined
        ? undefined
        : find(file.path, `${owner.qualifiedName}.${call.name}`);
    }
    if (call.receiver !== null) {
      const binding = byLocal.get(call.receiver);
      if (binding?.imported === null) return find(binding.target, call.name);
      return binding === undefined ? find(file.path, `${call.receiver}.${call.name}`) : undefined;
    }
    const binding = byLocal.get(call.name);
    if (binding === undefined) return find(file.path, call.name);
    if (binding.imported === null) return undefined;
    if (binding.imported === "default") {
      return find(binding.target, "default") ?? find(binding.target, binding.local);
    }
    return find(binding.target, binding.imported);
  };

  const edges = new Map<string, CallEdge>();
  for (const call of calls) {
    const to = callee(call);
    if (to === undefined) continue;
    const from = enclosing(call.line)?.id ?? file.id;
    if (from === to.id) continue;
    const key = `${from}\0${to.id}`;
    if (!edges.has(key)) edges.set(key, { from, to: to.id, line: call.line });
  }
  return [...edges.values()];
}
