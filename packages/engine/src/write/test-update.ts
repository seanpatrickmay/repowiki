import type { Revision } from "@repowiki/core";
import {
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makeRevision,
  SHA_C,
} from "@repowiki/core/test-fixtures";
import type { CommitInfo } from "../index/index.ts";
import { testWiki } from "./test-wiki.ts";
import type { PageRewrite, PlannedClaim } from "./update-pack.ts";

/**
 * testWiki()'s signals page as an earlier build stored it, at SHA_C: a lead (c1) over an
 * overview claim citing ingest_chunk (c2) and a history claim (c3). Test-only.
 */
export function storedSignalsPage(): Revision {
  return makeRevision({
    id: "signals-cccccccccccc",
    sha: SHA_C,
    sections: [
      {
        key: "lead",
        claims: [
          leadClaim({
            id: "c1",
            text: "**Signal ingestion** turns chunks into signals.",
            supports: ["c2", "c3"],
          }),
        ],
      },
      {
        key: "overview",
        claims: [
          bodyClaim({
            id: "c2",
            text: "`ingest_chunk()` keeps at most 50 signals.",
            citations: [codeCitation({ sha: SHA_C })],
          }),
        ],
      },
      {
        key: "history",
        claims: [
          bodyClaim({
            id: "c3",
            kind: "history",
            text: "Signal ingestion was added in January 2026.",
            citations: [
              commitCitation({
                sha: `a${"1".repeat(39)}`,
                subject: "feat: add signal ingestion",
                pr: 11,
              }),
            ],
          }),
        ],
      },
    ],
  });
}

/** The stored page's claims with c2 (and so the lead c1) stale. Test-only. */
export function plannedClaims(page: Revision = storedSignalsPage()): PlannedClaim[] {
  const stale = new Set(["c1", "c2"]);
  return page.sections.flatMap((section) =>
    section.claims.map((claim) => ({
      key: section.key,
      claim,
      status: stale.has(claim.id) ? ("stale" as const) : ("fresh" as const),
      reasons:
        claim.id === "c2"
          ? ["src/signals/ingest.py:10-24 at ccccccc: the cited lines changed"]
          : claim.id === "c1"
            ? ["it summarizes c2, which changed"]
            : [],
    })),
  );
}

/** The revert commit testWiki()'s history holds, as an update's new commit. Test-only. */
export const REVERT_COMMIT: CommitInfo = testWiki().history[0] as CommitInfo;

/** The signals page's update at testWiki()'s sha: c2 went stale when ingest.py changed. Test-only. */
export function signalsRewrite(overrides: Partial<PageRewrite> = {}): PageRewrite {
  return {
    featureId: "signals",
    revision: storedSignalsPage(),
    claims: plannedClaims(),
    gaps: [],
    changed: [
      {
        status: "modified",
        oldPath: "src/signals/ingest.py",
        newPath: "src/signals/ingest.py",
        hunks: [],
        binary: false,
      },
    ],
    commits: [REVERT_COMMIT],
    membershipChanged: false,
    ...overrides,
  };
}
