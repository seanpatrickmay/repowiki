import { contentHash, type Manifest, type Revision } from "@repowiki/core";
import { INGEST_PY, makeArchitecture, sourceLines } from "@repowiki/core/test-fixtures";
import {
  createTestRepo,
  DEFAULT_MAX_FILE_BYTES,
  indexRepo,
  readHistory,
  readSources,
  type TestRepo,
} from "../index/index.ts";
import { openStore, type Store } from "../store/index.ts";
import type { ArchitectureDraft } from "../verify/index.ts";
import type { UpdateInput } from "./plan.ts";

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

/** The update input at `sha`: index, sources and history read from the fixture repo. */
export async function inputAt(repo: TestRepo, sha: string): Promise<UpdateInput> {
  return {
    repo: repo.dir,
    index: await indexRepo(repo.dir, sha),
    sources: readSources(repo.dir, sha, DEFAULT_MAX_FILE_BYTES),
    history: readHistory(repo.dir, sha),
  };
}

/**
 * A fixture repository and an in-memory store built at its first commit (spec §8): signals owns
 * src/signals/ (ingest.py, store.py) and docs/signals.md, deliverables owns src/deliverables/
 * crud.py; each has a stored page whose overview claim cites its code and whose history claim
 * cites the first commit. The project's article is stored too, written from both pages. Test-only.
 */
export async function builtWiki(): Promise<{ repo: TestRepo; store: Store; first: string }> {
  const repo = createTestRepo();
  repo.write("src/signals/ingest.py", INGEST_PY);
  repo.write("src/signals/store.py", STORE_PY);
  repo.write("src/deliverables/crud.py", CRUD_PY);
  repo.write("docs/signals.md", "# Signals\n\nHow signals work.\n");
  const first = repo.commit("feat: add signals and deliverables");
  const { index, history } = await inputAt(repo, first);
  const featureOf = (path: string) =>
    path.startsWith("src/deliverables/") ? "deliverables" : "signals";
  const membership: Manifest["membership"] = {};
  for (const file of index.files) {
    membership[file.id] = { featureId: featureOf(file.path), weight: 1 };
    for (const symbol of file.symbols)
      membership[symbol.id] = { featureId: featureOf(file.path), weight: 1 };
  }
  const manifest: Manifest = {
    sha: first,
    features: [
      {
        id: "signals",
        title: "Signal ingestion",
        aliases: ["signal pipeline"],
        status: { kind: "active" },
        lineage: [{ kind: "create", sha: first }],
      },
      {
        id: "deliverables",
        title: "Deliverables",
        aliases: ["work items"],
        status: { kind: "active" },
        lineage: [{ kind: "create", sha: first }],
      },
    ],
    membership,
  };
  const date = history[0]?.date as string;
  const code = (path: string, text: string, start: number, end: number, symbol: string) => ({
    kind: "code" as const,
    path,
    startLine: start,
    endLine: end,
    sha: first,
    symbol,
    contentHash: contentHash(sourceLines(text, start, end)),
  });
  const page = (featureId: string, title: string, cite: ReturnType<typeof code>): Revision => ({
    id: `${featureId}-${first.slice(0, 12)}`,
    featureId,
    sha: first,
    commitDate: date,
    generatedAt: "2026-10-03T12:00:00Z",
    parentId: null,
    reason: "build",
    pr: null,
    model: "claude-haiku-4-5-20251001",
    tokens: { in: 1000, out: 200, cacheRead: 0, cacheWrite: 0 },
    infobox: {
      files: 1,
      loc: 10,
      languages: ["Python"],
      entryPoints: [],
      firstCommitDate: date,
      lastCommitDate: date,
    },
    diagram: null,
    seeAlso: [],
    sections: [
      {
        key: "lead",
        claims: [
          {
            id: "c1",
            text: `**${title}** is a feature.`,
            kind: "fact",
            citations: [],
            supports: ["c2", "c3"],
            staleSince: null,
            hook: false,
          },
        ],
      },
      {
        key: "overview",
        claims: [
          {
            id: "c2",
            text: `${title} has code.`,
            kind: "fact",
            citations: [cite],
            supports: [],
            staleSince: null,
            hook: false,
          },
        ],
      },
      {
        key: "history",
        claims: [
          {
            id: "c3",
            text: `${title} was added first.`,
            kind: "history",
            citations: [
              {
                kind: "commit",
                sha: first,
                subject: "feat: add signals and deliverables",
                pr: null,
              },
            ],
            supports: [],
            staleSince: null,
            hook: false,
          },
        ],
      },
    ],
  });
  const store = openStore(":memory:");
  store.putManifest(manifest, { llmRevised: true });
  store.putRevision(
    page(
      "signals",
      "Signal ingestion",
      code("src/signals/ingest.py", INGEST_PY, 10, 24, "ingest_chunk"),
    ),
  );
  store.putRevision(
    page(
      "deliverables",
      "Deliverables",
      code("src/deliverables/crud.py", CRUD_PY, 4, 7, "complete"),
    ),
  );
  store.setHead(first);
  store.putArchitecture(
    makeArchitecture({
      id: `architecture-${first.slice(0, 12)}-1`,
      sha: first,
      commitDate: date,
      basis: store
        .listCurrentRevisions()
        .map((r) => r.id)
        .sort(),
      edges: [],
    }),
  );
  return { repo, store, first };
}

/** An article draft for builtWiki's repository that verifies cleanly at any later commit. */
export function articleAnswer(): ArchitectureDraft {
  return {
    sections: [
      {
        key: "lead",
        claims: [
          {
            id: "l1",
            text: "**sample** is built from [[signals]] and [[deliverables]].",
            cite: [],
            pages: [],
            supports: ["y1"],
          },
        ],
      },
      {
        key: "layers",
        claims: [
          {
            id: "y1",
            text: "The deliverables layer hands a completed deliverable's notes to ingestion.",
            cite: [],
            pages: ["deliverables", "signals"],
            supports: [],
          },
        ],
      },
    ],
  };
}
