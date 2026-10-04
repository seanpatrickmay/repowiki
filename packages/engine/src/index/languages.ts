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
        hasError: tree.rootNode.hasError,
        dispose: () => tree.delete(),
      };
    },
  };
}
