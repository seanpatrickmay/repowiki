import type { Architecture, ArchitectureClaim } from "./architecture.ts";
import type { CodeCitation, CommitCitation } from "./citation.ts";
import type { Claim } from "./claim.ts";
import { contentHash } from "./content-hash.ts";
import type { Feature } from "./feature.ts";
import type { LedgerEntry } from "./llm.ts";
import type { Manifest } from "./manifest.ts";
import type { Revision } from "./revision.ts";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

/** src/signals/ingest.py as the fixtures cite it: 31 lines, with ingest_chunk on lines 10-24. */
export const INGEST_PY = `${[
  '"""Turns ingested chunks into signals."""',
  "",
  "from dataclasses import dataclass",
  "",
  "from .store import save_signal",
  "",
  "MAX_SIGNALS = 50",
  "",
  "",
  "def ingest_chunk(chunk):",
  '    """Creates one signal per sentence in the chunk."""',
  "    signals = []",
  "    # Blank sentences make no signal.",
  "    for sentence in chunk.sentences:",
  "        if not sentence.text.strip():",
  "            continue",
  "        signal = Signal(text=sentence.text, source=chunk.source)",
  "        signals.append(signal)",
  "        if len(signals) >= MAX_SIGNALS:",
  "            # TODO: page through long chunks instead of truncating",
  "            break",
  "    for signal in signals:",
  "        save_signal(signal)",
  "    return signals",
  "",
  "",
  "@dataclass",
  "class Signal:",
  "    text: str",
  "    source: str",
  "",
].join("\n")}\n`;

/** Lines start..end (1-based, inclusive) of a source text, without the final newline. */
export function sourceLines(source: string, start: number, end: number): string {
  return source
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
}

export function codeCitation(overrides: Partial<CodeCitation> = {}): CodeCitation {
  return {
    kind: "code",
    path: "src/signals/ingest.py",
    startLine: 10,
    endLine: 24,
    sha: SHA_A,
    symbol: "ingest_chunk",
    contentHash: contentHash(sourceLines(INGEST_PY, 10, 24)),
    ...overrides,
  };
}

export function commitCitation(overrides: Partial<CommitCitation> = {}): CommitCitation {
  return {
    kind: "commit",
    sha: SHA_A,
    subject: "feat: add signal ingestion",
    pr: 45,
    ...overrides,
  };
}

export function bodyClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "c-1",
    text: "Signals are created from ingested chunks.",
    kind: "fact",
    citations: [codeCitation()],
    supports: [],
    staleSince: null,
    hook: false,
    ...overrides,
  };
}

export function leadClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "lead-1",
    text: "**Signal ingestion** is the subsystem that turns ingested chunks into signals.",
    kind: "fact",
    citations: [],
    supports: ["c-1"],
    staleSince: null,
    hook: false,
    ...overrides,
  };
}

export function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "signals",
    title: "Signal ingestion",
    aliases: ["signal pipeline"],
    status: { kind: "active" },
    lineage: [{ kind: "create", sha: SHA_A }],
    ...overrides,
  };
}

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    sha: SHA_A,
    features: [
      makeFeature(),
      makeFeature({ id: "deliverables", title: "Deliverables", aliases: [] }),
    ],
    membership: {
      "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 },
      "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.7 },
    },
    ...overrides,
  };
}

export function makeLedgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    runId: "run-1",
    at: "2026-10-01T12:00:00.000Z",
    purpose: "manifest",
    model: "claude-haiku-4-5-20251001",
    featureId: null,
    batch: false,
    cacheKey: null,
    tokens: { in: 1000, out: 200, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

export function makeRevision(overrides: Partial<Revision> = {}): Revision {
  return {
    id: "rev-1",
    featureId: "signals",
    sha: SHA_A,
    commitDate: "2026-02-03T10:00:00-05:00",
    generatedAt: "2026-09-30T20:00:00Z",
    parentId: null,
    reason: "build",
    pr: null,
    model: "claude-haiku-4-5",
    tokens: { in: 1200, out: 300, cacheRead: 0, cacheWrite: 0 },
    infobox: {
      files: 3,
      loc: 240,
      languages: ["Python"],
      entryPoints: ["src/signals/ingest.py"],
      firstCommitDate: "2026-01-26T09:00:00-05:00",
      lastCommitDate: "2026-02-03T10:00:00-05:00",
    },
    diagram: null,
    seeAlso: ["deliverables"],
    sections: [
      { key: "lead", claims: [leadClaim()] },
      { key: "overview", claims: [bodyClaim()] },
    ],
    ...overrides,
  };
}

/** A body claim of the Architecture article: a cited claim that names no page. */
export function architectureClaim(overrides: Partial<ArchitectureClaim> = {}): ArchitectureClaim {
  return {
    ...bodyClaim({ id: "a-1", text: "Signals feed deliverables." }),
    pages: [],
    ...overrides,
  };
}

/** An Architecture article over makeManifest()'s two features, written at SHA_A. */
export function makeArchitecture(overrides: Partial<Architecture> = {}): Architecture {
  return {
    id: "architecture-aaaaaaaaaaaa-1",
    sha: SHA_A,
    commitDate: "2026-02-03T10:00:00-05:00",
    generatedAt: "2026-09-30T20:00:00Z",
    parentId: null,
    reason: "build",
    pr: null,
    model: "claude-haiku-4-5",
    tokens: { in: 4000, out: 900, cacheRead: 0, cacheWrite: 0 },
    basis: ["rev-1"],
    edges: [{ from: "deliverables", to: "signals", imports: 1, calls: 2 }],
    diagram: null,
    sections: [
      {
        key: "lead",
        claims: [
          {
            ...leadClaim({
              id: "lead-1",
              text: "**demo** is built from signals and deliverables.",
            }),
            supports: ["a-1"],
            pages: [],
          },
        ],
      },
      { key: "layers", claims: [architectureClaim()] },
      {
        key: "dependencies",
        claims: [architectureClaim({ id: "a-2", citations: [], pages: ["signals"] })],
      },
    ],
    ...overrides,
  };
}
