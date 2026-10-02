import { type Manifest, memberId } from "@repowiki/core";
import { INGEST_PY, makeFeature, makeManifest, SHA_A } from "@repowiki/core/test-fixtures";
import type { CommitInfo, IndexedFile, RepoIndex } from "../index/index.ts";

export const STORE_PY = "def save_signal(signal):\n    return signal\n";
export const CRUD_PY = [
  "from src.signals.ingest import ingest_chunk",
  "",
  "",
  "def complete(deliverable):",
  '    """Marks a deliverable completed."""',
  "    deliverable.done = True",
  "    return ingest_chunk(deliverable.notes)",
  "",
].join("\n");
export const README = "# Signals\n\nHow signals work.\n";

function file(
  path: string,
  text: string,
  symbols: [string, number, number, string][] = [],
): IndexedFile {
  return {
    id: memberId(path),
    path,
    language: path.endsWith(".py") ? "python" : null,
    bytes: text.length,
    loc: text.replace(/\n$/, "").split("\n").length,
    skipped: null,
    parseError: false,
    symbols: symbols.map(([qualifiedName, startLine, endLine, kind]) => ({
      id: memberId(path, qualifiedName),
      qualifiedName,
      kind: kind as "function",
      startLine,
      endLine,
      exported: true,
    })),
  };
}

/** Two features over four files at SHA_A, with an import and a call across them. Test-only. */
export function testWiki() {
  const sources = new Map([
    ["docs/signals.md", README],
    ["src/deliverables/crud.py", CRUD_PY],
    ["src/signals/ingest.py", INGEST_PY],
    ["src/signals/store.py", STORE_PY],
  ]);
  const index: RepoIndex = {
    sha: SHA_A,
    files: [
      file("docs/signals.md", README),
      file("src/deliverables/crud.py", CRUD_PY, [["complete", 4, 7, "function"]]),
      file("src/signals/ingest.py", INGEST_PY, [
        ["ingest_chunk", 10, 24, "function"],
        ["Signal", 27, 30, "class"],
      ]),
      file("src/signals/store.py", STORE_PY, [["save_signal", 1, 2, "function"]]),
    ],
    imports: [
      { from: "src/deliverables/crud.py", to: "src/signals/ingest.py", line: 1 },
      { from: "src/signals/ingest.py", to: "src/signals/store.py", line: 5 },
    ],
    calls: [
      {
        from: "src/deliverables/crud.py#complete",
        to: "src/signals/ingest.py#ingest_chunk",
        line: 7,
      },
      {
        from: "src/signals/ingest.py#ingest_chunk",
        to: "src/signals/store.py#save_signal",
        line: 23,
      },
    ],
    unresolved: [],
    coChange: { commitsConsidered: 2, commitsSkipped: 0, fileCommits: {}, pairs: [] },
    invalidPaths: [],
  };
  const membership: Manifest["membership"] = {};
  const member = (path: string, featureId: string, weight: number) => {
    membership[memberId(path)] = { featureId, weight };
    for (const s of index.files.find((f) => f.path === path)?.symbols ?? []) {
      membership[s.id] = { featureId, weight };
    }
  };
  member("src/signals/ingest.py", "signals", 1);
  member("src/signals/store.py", "signals", 0.8);
  member("docs/signals.md", "signals", 0.5);
  member("src/deliverables/crud.py", "deliverables", 1);
  const manifest = makeManifest({
    features: [
      makeFeature(),
      makeFeature({ id: "deliverables", title: "Deliverables", aliases: ["deliverable records"] }),
    ],
    membership,
  });
  const history: CommitInfo[] = [
    {
      sha: `b${"1".repeat(39)}`,
      parents: [`a${"1".repeat(39)}`],
      date: "2026-02-03T10:00:00-05:00",
      subject: 'Revert "feat: page through long chunks"',
      files: ["src/signals/ingest.py"],
      pr: 12,
    },
    {
      sha: `a${"1".repeat(39)}`,
      parents: [],
      date: "2026-01-26T09:00:00-05:00",
      subject: "feat: add signal ingestion",
      files: ["src/signals/ingest.py", "src/signals/store.py", "src/deliverables/crud.py"],
      pr: 11,
    },
  ];
  return { index, manifest, sources, history };
}
