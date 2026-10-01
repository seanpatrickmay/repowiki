import type { CodeCitation, CommitCitation } from "./citation.ts";
import type { Claim } from "./claim.ts";
import { contentHash } from "./content-hash.ts";
import type { Feature } from "./feature.ts";
import type { Manifest } from "./manifest.ts";
import type { Revision } from "./revision.ts";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

export function codeCitation(overrides: Partial<CodeCitation> = {}): CodeCitation {
  return {
    kind: "code",
    path: "src/signals/ingest.py",
    startLine: 10,
    endLine: 24,
    sha: SHA_A,
    symbol: "ingest_chunk",
    contentHash: contentHash("def ingest_chunk(chunk):\n    ..."),
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
