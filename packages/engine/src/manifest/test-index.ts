import { memberId } from "@repowiki/core";
import type { IndexedFile, RepoIndex, SourceLanguage, SymbolKind } from "../index/index.ts";

function file(path: string, language: SourceLanguage | null, symbols: [string, SymbolKind][] = []) {
  const indexed: IndexedFile = {
    id: memberId(path),
    path,
    language,
    bytes: 100,
    loc: 10,
    skipped: null,
    parseError: false,
    symbols: symbols.map(([qualifiedName, kind], i) => ({
      id: memberId(path, qualifiedName),
      qualifiedName,
      kind,
      startLine: i + 1,
      endLine: i + 1,
      exported: true,
    })),
  };
  return indexed;
}

/**
 * A small two-feature repository as a hand-built RepoIndex: a Python API with its tests and a
 * doc whose path needs escaping, and a TSX frontend. Test-only.
 */
export function sampleIndex(): RepoIndex {
  return {
    sha: "c".repeat(40),
    files: [
      file("docs/C#.md", null),
      file("src/api/app.py", "python", [
        ["App", "class"],
        ["App.run", "method"],
        ["create_app", "function"],
      ]),
      file("src/api/routes.py", "python", [["router", "variable"]]),
      file("tests/test_routes.py", "python", [["test_list", "function"]]),
      file("web/src/api.ts", "typescript", [["fetchJson", "function"]]),
      file("web/src/main.tsx", "tsx", [["Main", "function"]]),
    ],
    imports: [
      { from: "src/api/routes.py", to: "src/api/app.py", line: 1 },
      { from: "tests/test_routes.py", to: "src/api/routes.py", line: 1 },
      { from: "web/src/main.tsx", to: "web/src/api.ts", line: 1 },
    ],
    unresolved: [
      { from: "src/api/app.py", specifier: "fastapi", line: 1, external: true },
      { from: "web/src/main.tsx", specifier: "react", line: 1, external: true },
    ],
    coChange: {
      commitsConsidered: 4,
      commitsSkipped: 0,
      fileCommits: { "docs/C#.md": 2, "src/api/app.py": 3, "web/src/api.ts": 1 },
      pairs: [{ a: "docs/C#.md", b: "src/api/app.py", count: 2 }],
    },
    invalidPaths: [],
    calls: [],
  };
}
