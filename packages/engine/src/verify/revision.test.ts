import { contentHash } from "@repowiki/core";
import {
  bodyClaim,
  codeCitation,
  commitCitation,
  INGEST_PY,
  leadClaim,
  makeRevision,
  SHA_A,
  SHA_B,
  SHA_C,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import type { CommitInfo } from "../index/index.ts";
import { commitCitationProblems, revisionProblems } from "./revision.ts";

const at = (files: Record<string, string>) => (sha: string) =>
  new Map(sha === SHA_A ? Object.entries(files) : []);

describe("revisionProblems", () => {
  it("passes a revision whose code citations still hash to their lines", () => {
    expect(revisionProblems(makeRevision(), at({ "src/signals/ingest.py": INGEST_PY }))).toEqual(
      [],
    );
  });

  it("reports a missing file, changed lines and an unsafe diagram", () => {
    const changed = codeCitation({ startLine: 3, endLine: 3, contentHash: contentHash("other") });
    const revision = makeRevision({
      diagram: 'flowchart LR\n  click n1 "https://evil.example"',
      sections: [
        { key: "lead", claims: [leadClaim({ supports: ["c-1", "c-2"] })] },
        {
          key: "overview",
          claims: [
            bodyClaim(),
            bodyClaim({ id: "c-2", citations: [changed, codeCitation({ path: "gone.py" })] }),
          ],
        },
      ],
    });
    expect(revisionProblems(revision, at({ "src/signals/ingest.py": INGEST_PY }))).toEqual([
      "signals c-2 src/signals/ingest.py:3-3: the cited lines changed",
      "signals c-2 gone.py:10-24: no such file at aaaaaaa",
      "signals: diagram line 2 is not a node or a labelled arrow",
    ]);
  });

  describe("at each citation's own sha", () => {
    const OLD = INGEST_PY.replace("MAX_SIGNALS = 50", "MAX_SIGNALS = 5");
    const withClaims = (...citations: ReturnType<typeof codeCitation>[]) =>
      makeRevision({
        sections: [
          { key: "lead", claims: [leadClaim({ supports: ["c-1"] })] },
          { key: "overview", claims: [bodyClaim({ citations })] },
        ],
      });
    const bySha = (calls: string[]) => (sha: string) => {
      calls.push(sha);
      if (sha === SHA_A) return new Map([["src/signals/ingest.py", INGEST_PY]]);
      if (sha === SHA_B) return new Map([["src/signals/ingest.py", OLD]]);
      throw new Error(`unknown revision ${sha}`);
    };

    it("hashes each citation against the file at its own sha, not the revision's", () => {
      const atB = codeCitation({
        sha: SHA_B,
        startLine: 7,
        endLine: 7,
        contentHash: contentHash("MAX_SIGNALS = 5"),
      });
      const atA = codeCitation({
        sha: SHA_A,
        startLine: 7,
        endLine: 7,
        contentHash: contentHash("MAX_SIGNALS = 50"),
      });
      expect(revisionProblems(withClaims(atA, atB), bySha([]))).toEqual([]);
      // The same two hashes swapped: each only matches at the other sha.
      const wrongB = { ...atB, contentHash: atA.contentHash };
      const wrongA = { ...atA, contentHash: atB.contentHash };
      expect(revisionProblems(withClaims(wrongA, wrongB), bySha([]))).toEqual([
        "signals c-1 src/signals/ingest.py:7-7: the cited lines changed",
        "signals c-1 src/signals/ingest.py:7-7: the cited lines changed",
      ]);
    });

    it("reads each distinct sha once", () => {
      const calls: string[] = [];
      const citations = [
        codeCitation(),
        codeCitation({
          sha: SHA_B,
          contentHash: contentHash(OLD.split("\n").slice(9, 24).join("\n")),
        }),
        codeCitation(),
        codeCitation({ sha: SHA_B, contentHash: contentHash("other") }),
      ];
      expect(revisionProblems(withClaims(...citations), bySha(calls))).toEqual([
        "signals c-1 src/signals/ingest.py:10-24: the cited lines changed",
      ]);
      expect(calls).toEqual([SHA_A, SHA_B]);
    });

    it("reports an unknown sha for every citation at it, and never throws", () => {
      const calls: string[] = [];
      const gone = [codeCitation({ sha: SHA_C }), codeCitation({ sha: SHA_C, path: "other.py" })];
      expect(revisionProblems(withClaims(codeCitation(), ...gone), bySha(calls))).toEqual([
        `signals c-1 src/signals/ingest.py:10-24: no such commit ${SHA_C}`,
        `signals c-1 other.py:10-24: no such commit ${SHA_C}`,
      ]);
      expect(calls).toEqual([SHA_A, SHA_C]);
    });

    it("skips commit citations: no hashing, no lookup, no problem", () => {
      const calls: string[] = [];
      const revision = makeRevision({
        sections: [
          { key: "lead", claims: [leadClaim({ supports: ["c-1"] })] },
          {
            key: "overview",
            claims: [bodyClaim({ citations: [commitCitation({ sha: SHA_C })] })],
          },
        ],
      });
      expect(revisionProblems(revision, bySha(calls))).toEqual([]);
      expect(calls).toEqual([]);
    });
  });
});

describe("commitCitationProblems", () => {
  const commit = (sha: string, subject: string): CommitInfo => ({
    sha,
    parents: [],
    date: "2026-02-03T10:00:00-05:00",
    subject,
    files: [],
    pr: null,
  });
  const revision = makeRevision({
    sections: [
      { key: "lead", claims: [leadClaim({ supports: ["c-1", "h-1", "h-2", "h-3"] })] },
      { key: "overview", claims: [bodyClaim()] },
      {
        key: "history",
        claims: [
          bodyClaim({ id: "h-1", kind: "history", citations: [commitCitation()] }),
          bodyClaim({
            id: "h-2",
            kind: "history",
            citations: [commitCitation({ sha: SHA_B, subject: "feat: b" })],
          }),
          bodyClaim({
            id: "h-3",
            kind: "history",
            citations: [commitCitation({ sha: SHA_C, subject: "feat: c" })],
          }),
        ],
      },
    ],
  });

  it("passes commit citations that name a reachable commit with its subject", () => {
    const history = [
      commit(SHA_A, "feat: add signal ingestion"),
      commit(SHA_B, "feat: b"),
      commit(SHA_C, "feat: c"),
    ];
    expect(commitCitationProblems(revision, history)).toEqual([]);
  });

  it("reports a commit the history does not hold and one cited under another subject", () => {
    const history = [commit(SHA_A, "feat: add signal ingestion"), commit(SHA_B, "feat: other")];
    expect(commitCitationProblems(revision, history)).toEqual([
      "signals h-2 commit:bbbbbbb: the commit's subject is not the one cited",
      "signals h-3 commit:ccccccc: no such commit in the history of the wiki's sha",
    ]);
  });
});
