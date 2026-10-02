import { contentHash } from "@repowiki/core";
import {
  bodyClaim,
  codeCitation,
  INGEST_PY,
  leadClaim,
  makeRevision,
  SHA_A,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { revisionProblems } from "./revision.ts";

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
});
