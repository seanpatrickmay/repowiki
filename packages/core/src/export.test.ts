import { describe, expect, it } from "vitest";
import { WikiExport } from "./export.ts";
import type { Revision } from "./revision.ts";
import { makeManifest, makeRevision, SHA_B } from "./test-fixtures.ts";

const first = makeRevision();
const second = makeRevision({ id: "rev-2", parentId: "rev-1", reason: "update", sha: SHA_B });

function makeExport(overrides: Partial<WikiExport> = {}): WikiExport {
  return {
    schemaVersion: 2,
    repo: "next-chief-of-staff",
    head: SHA_B,
    exportedAt: "2026-09-30T21:00:00Z",
    manifest: makeManifest(),
    pages: [second],
    history: { signals: [first, second] },
    ...overrides,
  };
}

function messages(wiki: unknown): string[] {
  const result = WikiExport.safeParse(wiki);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("WikiExport", () => {
  it("accepts a consistent export with full revision bodies in history", () => {
    expect(WikiExport.parse(makeExport())).toEqual(makeExport());
  });

  it("rejects schema version 1, whose history held metadata only", () => {
    expect(WikiExport.safeParse({ ...makeExport(), schemaVersion: 1 }).success).toBe(false);
  });

  it("rejects pages for features missing from the manifest", () => {
    const page = makeRevision({ featureId: "ghost" });
    expect(messages(makeExport({ pages: [page], history: { ghost: [page] } }))).toContain(
      "ghost is not in the manifest",
    );
  });

  it("requires each page to be the last entry of its history", () => {
    expect(messages(makeExport({ history: { signals: [first] } }))).toContain(
      "history for signals must end with page rev-2",
    );
  });

  it("rejects two pages for the same feature", () => {
    expect(messages(makeExport({ pages: [second, second] }))).toEqual(["two pages for signals"]);
  });

  it("rejects a history revision filed under another feature", () => {
    const stray: Revision = { ...first, featureId: "deliverables" };
    expect(messages(makeExport({ history: { signals: [stray, second] } }))).toContain(
      "history for signals holds revision rev-1 of deliverables",
    );
  });

  it("rejects a history whose parent chain is broken", () => {
    const orphan = makeRevision({ id: "rev-2", parentId: "rev-x", reason: "update" });
    expect(
      messages(makeExport({ pages: [orphan], history: { signals: [first, orphan] } })),
    ).toEqual(["revision rev-2 must have parent rev-1"]);
  });

  it("rejects a history that starts with a parented revision", () => {
    expect(messages(makeExport({ history: { signals: [second] } }))).toEqual([
      "revision rev-2 must have parent null",
    ]);
  });

  it("rejects a history with no page", () => {
    const wiki = makeExport({ history: { signals: [first, second], deliverables: [first] } });
    expect(messages(wiki)).toContain("history for deliverables has no page");
  });
});
