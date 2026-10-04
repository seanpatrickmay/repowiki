import { type Citation, contentHash } from "@repowiki/core";
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
  sourceLines,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import type { FileChange } from "../index/index.ts";
import { type RemapContext, remapCitation, remapClaims } from "./stale.ts";

const PATH = "src/signals/ingest.py";
const TWO_LINES_ON_TOP = `# one\n# two\n${INGEST_PY}`;

/** A RemapContext at SHA_B whose diff from SHA_A is `changes`, over `sources`. */
function context(changes: FileChange[], sources: Record<string, string>): RemapContext {
  return {
    sha: SHA_B,
    changesSince: (from) => (from === SHA_A ? changes : []),
    sources: new Map(Object.entries(sources)),
    symbolsOf: (path) =>
      path === PATH ? [{ qualifiedName: "ingest_chunk", startLine: 12, endLine: 26 }] : [],
  };
}

const modified = (hunks: FileChange["hunks"], newPath = PATH): FileChange => ({
  status: newPath === PATH ? "modified" : "renamed",
  oldPath: PATH,
  newPath,
  hunks,
  binary: false,
});
const insertTwoOnTop = { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 };

describe("remapCitation", () => {
  it("moves a citation of an unchanged file to the new sha", () => {
    const fate = remapCitation(codeCitation(), context([], { [PATH]: INGEST_PY }));
    expect(fate).toEqual({ fresh: codeCitation({ sha: SHA_B, symbol: null }) });
  });

  it("follows lines that moved down, naming the symbol around them at the new sha", () => {
    const fate = remapCitation(
      codeCitation(),
      context([modified([insertTwoOnTop])], { [PATH]: TWO_LINES_ON_TOP }),
    );
    expect(fate).toEqual({
      fresh: codeCitation({ startLine: 12, endLine: 26, sha: SHA_B, symbol: "ingest_chunk" }),
    });
  });

  it("follows a rename", () => {
    const fate = remapCitation(
      codeCitation(),
      context([modified([], "src/signals/chunks.py")], { "src/signals/chunks.py": INGEST_PY }),
    );
    expect(fate).toEqual({
      fresh: codeCitation({ path: "src/signals/chunks.py", sha: SHA_B, symbol: null }),
    });
  });

  it.each([
    [
      "a changed line",
      [modified([{ oldStart: 12, oldCount: 1, newStart: 12, newCount: 1 }])],
      "the cited lines changed",
      PATH,
    ],
    [
      "a deleted file",
      [{ status: "deleted", oldPath: PATH, newPath: null, hunks: [], binary: false }],
      "its file was deleted",
      null,
    ],
    ["a binary file", [{ ...modified([]), binary: true }], "its file is now binary", PATH],
  ] as [string, FileChange[], string, string | null][])(
    "is stale for %s",
    (_name, changes, why, path) => {
      expect(remapCitation(codeCitation(), context(changes, { [PATH]: INGEST_PY }))).toEqual({
        stale: why,
        path,
      });
    },
  );

  it("is stale when the hash at the new sha disagrees, whatever the hunks say", () => {
    const edited = INGEST_PY.replace("    signals = []", "    signals = list()");
    expect(remapCitation(codeCitation(), context([modified([])], { [PATH]: edited }))).toEqual({
      stale: "the cited lines changed",
      path: PATH,
    });
  });

  it("reads the diff from the citation's own sha, not the wiki's head", () => {
    // From SHA_A nothing changed; from SHA_C two lines went on top.
    const ctx: RemapContext = {
      ...context([], { [PATH]: TWO_LINES_ON_TOP }),
      changesSince: (from) => (from === SHA_C ? [modified([insertTwoOnTop])] : []),
    };
    expect(remapCitation(codeCitation({ sha: SHA_C }), ctx)).toEqual({
      fresh: codeCitation({ startLine: 12, endLine: 26, sha: SHA_B, symbol: "ingest_chunk" }),
    });
  });

  it("is stale when the cited range runs past the end of the file at the new sha", () => {
    const cut = INGEST_PY.split("\n").slice(0, 20).join("\n");
    expect(remapCitation(codeCitation(), context([], { [PATH]: cut }))).toEqual({
      stale: "its file cannot be read at this commit",
      path: PATH,
    });
  });

  it("is stale when the file cannot be read at the new sha", () => {
    expect(remapCitation(codeCitation(), context([], {}))).toEqual({
      stale: "its file cannot be read at this commit",
      path: PATH,
    });
  });
});

describe("remapClaims", () => {
  const history = bodyClaim({ id: "h-1", kind: "history", citations: [commitCitation()] });
  const other = bodyClaim({
    id: "c-2",
    citations: [
      codeCitation({
        startLine: 27,
        endLine: 30,
        contentHash: contentHash(sourceLines(INGEST_PY, 27, 30)),
      }),
    ],
  });
  const page = makeRevision({
    sections: [
      {
        key: "lead",
        claims: [
          leadClaim({ supports: ["c-1"] }),
          leadClaim({ id: "lead-2", supports: ["c-2", "h-1"] }),
        ],
      },
      { key: "overview", claims: [bodyClaim(), other] },
      { key: "history", claims: [history] },
    ],
  });
  const editLine12 = context(
    [modified([{ oldStart: 12, oldCount: 1, newStart: 12, newCount: 1 }])],
    { [PATH]: INGEST_PY.replace("    signals = []", "    signals = list()") },
  );

  it("marks a changed claim and the lead that supports it stale, in page order", () => {
    const claims = remapClaims(page.sections, editLine12, new Set([PATH]));
    expect(claims.map((c) => [c.claim.id, c.status])).toEqual([
      ["lead-1", "stale"],
      ["lead-2", "fresh"],
      ["c-1", "stale"],
      ["c-2", "fresh"],
      ["h-1", "fresh"],
    ]);
    expect(claims[0]?.reasons).toEqual(["it summarizes c-1, which changed"]);
    expect(claims[2]?.reasons).toEqual([`${PATH}:10-24 at aaaaaaa: the cited lines changed`]);
    // The stale claim is kept as stored; the fresh one now cites the new sha.
    expect(claims[2]?.claim).toEqual(bodyClaim());
    expect(claims[3]?.claim.citations[0]).toMatchObject({ sha: SHA_B, startLine: 27 });
    expect(claims[4]?.claim).toEqual(history);
  });

  it("tries a claim stale since an earlier update again only when a file it cites changed now", () => {
    const old = makeRevision({
      sections: [
        { key: "lead", claims: [leadClaim({ staleSince: SHA_A })] },
        { key: "overview", claims: [bodyClaim({ staleSince: SHA_A })] },
      ],
    });
    const untouched = remapClaims(old.sections, editLine12, new Set(["src/other.py"]));
    expect(untouched.map((c) => c.status)).toEqual(["stale-kept", "stale-kept"]);
    const touched = remapClaims(old.sections, editLine12, new Set([PATH]));
    expect(touched.map((c) => c.status)).toEqual(["stale", "stale"]);
  });

  it("tries a stale claim again when only its file's new path is touched, or only a deleted file's old one", () => {
    const old = makeRevision({
      sections: [
        { key: "lead", claims: [leadClaim()] },
        { key: "overview", claims: [bodyClaim({ staleSince: SHA_A })] },
      ],
    });
    const renamed = "src/signals/chunks.py";
    // Renamed with its lines intact: touched through the new path, it heals there.
    const [, moved] = remapClaims(
      old.sections,
      context([modified([], renamed)], { [renamed]: INGEST_PY }),
      new Set([renamed]),
    );
    expect(moved).toMatchObject({ status: "fresh", claim: { staleSince: null } });
    expect(moved?.claim.citations[0]).toMatchObject({ path: renamed, sha: SHA_B });
    const deleted = context(
      [{ status: "deleted", oldPath: PATH, newPath: null, hunks: [], binary: false }],
      {},
    );
    const [, gone] = remapClaims(old.sections, deleted, new Set([PATH]));
    expect(gone).toMatchObject({
      status: "stale",
      reasons: [`${PATH}:10-24 at aaaaaaa: its file was deleted`],
    });
  });

  it("moves the code citation of a claim that also cites a commit, and keeps the commit as it is", () => {
    const mixed = bodyClaim({ citations: [codeCitation(), commitCitation()] });
    const [claim] = remapClaims(
      [{ key: "history", claims: [{ ...mixed, kind: "history" }] }],
      context([modified([insertTwoOnTop])], { [PATH]: TWO_LINES_ON_TOP }),
      new Set([PATH]),
    );
    expect(claim?.status).toBe("fresh");
    expect(claim?.claim.citations).toEqual([
      codeCitation({ startLine: 12, endLine: 26, sha: SHA_B, symbol: "ingest_chunk" }),
      commitCitation(),
    ]);
  });

  it("marks a claim stale when one of its citations changed, keeping every citation as stored", () => {
    const both = bodyClaim({ citations: [codeCitation(), other.citations[0] as Citation] });
    const [claim] = remapClaims([{ key: "overview", claims: [both] }], editLine12, new Set([PATH]));
    expect(claim).toMatchObject({
      status: "stale",
      reasons: [`${PATH}:10-24 at aaaaaaa: the cited lines changed`],
    });
    expect(claim?.claim).toEqual(both);
  });

  it("clears staleSince from a claim whose code came back", () => {
    const old = makeRevision({
      sections: [
        { key: "lead", claims: [leadClaim()] },
        { key: "overview", claims: [bodyClaim({ staleSince: SHA_A })] },
      ],
    });
    const [, healed] = remapClaims(
      old.sections,
      context([modified([])], { [PATH]: INGEST_PY }),
      new Set([PATH]),
    );
    expect(healed).toMatchObject({ status: "fresh", claim: { staleSince: null } });
  });
});
