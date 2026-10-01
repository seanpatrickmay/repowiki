import { describe, expect, it } from "vitest";
import { WikiExport } from "./export.ts";
import { makeManifest, makeRevision, SHA_A } from "./test-fixtures.ts";

function makeExport(overrides: Partial<WikiExport> = {}): WikiExport {
  const page = makeRevision();
  return {
    schemaVersion: 1,
    repo: "next-chief-of-staff",
    head: SHA_A,
    exportedAt: "2026-09-30T21:00:00Z",
    manifest: makeManifest(),
    pages: [page],
    history: {
      signals: [
        {
          id: page.id,
          sha: page.sha,
          commitDate: page.commitDate,
          reason: page.reason,
          pr: page.pr,
        },
      ],
    },
    ...overrides,
  };
}

describe("WikiExport", () => {
  it("accepts a consistent export", () => {
    expect(WikiExport.parse(makeExport())).toEqual(makeExport());
  });

  it("rejects a different schema version", () => {
    expect(WikiExport.safeParse({ ...makeExport(), schemaVersion: 2 }).success).toBe(false);
  });

  it("rejects pages for features missing from the manifest", () => {
    const page = makeRevision({ featureId: "ghost" });
    const history = {
      ghost: [
        { id: page.id, sha: page.sha, commitDate: page.commitDate, reason: page.reason, pr: null },
      ],
    };
    expect(WikiExport.safeParse(makeExport({ pages: [page], history })).success).toBe(false);
  });

  it("requires each page to be the last entry of its history", () => {
    expect(WikiExport.safeParse(makeExport({ history: { signals: [] } })).success).toBe(false);
  });

  it("rejects two pages for the same feature", () => {
    const page = makeRevision();
    const result = WikiExport.safeParse(makeExport({ pages: [page, page] }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(["two pages for signals"]);
  });
});
