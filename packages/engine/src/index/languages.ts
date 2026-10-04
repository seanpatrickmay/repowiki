import { createRequire } from "node:module";
import { Language, type Node, Parser } from "web-tree-sitter";

export type SourceLanguage = "python" | "typescript" | "tsx";

const GRAMMARS: Record<SourceLanguage, string> = {
  python: "tree-sitter-python/tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
};

/** The grammar used for a path, or null for files indexed at file level only. */
export function languageForPath(path: string): SourceLanguage | null {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".tsx")) return "tsx";
  if (/\.[cm]?ts$/.test(path)) return "typescript";
  return null;
}

/**
 * tree-sitter-typescript 0.23.2 (the latest release) cannot parse an import type as the only
 * type argument of a call with no arguments: `f<typeof import("x")>()` becomes the comparison
 * `f < typeof import("x")` followed by an ERROR node holding `>()`. The source is valid
 * TypeScript, so that one ERROR shape is not a syntax error. It sits next to the comparison, not
 * inside a call's type arguments, because the grammar never builds the call.
 */
function isImportTypeArgsMisparse(error: Node): boolean {
  if (!/^>\s*\(\s*\)$/.test(error.text)) return false;
  const prev = error.previousSibling;
  if (prev === null) return false;
  // The comparison must be the tail of the previous sibling and end where the ERROR starts, with
  // only whitespace between; a stray `>();` after a finished statement stays an error.
  if (prev.endIndex > error.startIndex) return false;
  const gap = error.tree.rootNode.text.slice(prev.endIndex, error.startIndex);
  if (!/^\s*$/.test(gap)) return false;
  return [prev, ...prev.descendantsOfType("binary_expression")].some((n) => {
    if (n.type !== "binary_expression" || n.childForFieldName("operator")?.type !== "<") {
      return false;
    }
    if (n.endIndex !== prev.endIndex) return false;
    const right = n.childForFieldName("right");
    return (
      right !== null &&
      [right, ...right.descendantsOfType("call_expression")].some(
        (c) => c.type === "call_expression" && c.childForFieldName("function")?.type === "import",
      )
    );
  });
}

/** True when the tree holds a syntax error other than the tolerated import-type misparse. */
function hasSyntaxError(node: Node): boolean {
  if (node.isMissing) return true;
  if (node.isError) return !isImportTypeArgsMisparse(node);
  if (!node.hasError) return false;
  const bad = node.children.filter((c) => c.hasError || c.isMissing);
  // An error flag with no flagged child cannot be explained, so it counts.
  return bad.length === 0 || bad.some(hasSyntaxError);
}

export interface ParsedSource {
  root: Node;
  hasError: boolean;
  /** Frees the WASM-side tree. Call once the root is no longer needed. */
  dispose(): void;
}

export interface SourceParser {
  parse(language: SourceLanguage, source: string): ParsedSource;
}

const require = createRequire(import.meta.url);
let languages: Promise<Map<SourceLanguage, Language>> | undefined;

async function loadLanguages(): Promise<Map<SourceLanguage, Language>> {
  await Parser.init();
  const ids = Object.keys(GRAMMARS) as SourceLanguage[];
  const loaded = await Promise.all(ids.map((id) => Language.load(require.resolve(GRAMMARS[id]))));
  return new Map(ids.map((id, i) => [id, loaded[i] as Language]));
}

export async function createSourceParser(): Promise<SourceParser> {
  languages ??= loadLanguages();
  const grammars = await languages;
  const parser = new Parser();
  return {
    parse(language, source) {
      parser.setLanguage(grammars.get(language) ?? null);
      const tree = parser.parse(source);
      if (tree === null) throw new Error(`tree-sitter produced no tree for ${language} source`);
      return {
        root: tree.rootNode,
        hasError: hasSyntaxError(tree.rootNode),
        dispose: () => tree.delete(),
      };
    },
  };
}
