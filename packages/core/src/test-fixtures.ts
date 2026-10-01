import type { CodeCitation, CommitCitation } from "./citation.ts";
import type { Claim } from "./claim.ts";
import { contentHash } from "./content-hash.ts";

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
