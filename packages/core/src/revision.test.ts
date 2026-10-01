import { describe, expect, it } from "vitest";
import { Revision } from "./revision.ts";
import { bodyClaim, leadClaim, makeRevision } from "./test-fixtures.ts";

const ok = (overrides: Parameters<typeof makeRevision>[0]) =>
  Revision.safeParse(makeRevision(overrides)).success;

describe("Revision", () => {
  it("accepts a build revision", () => {
    expect(Revision.parse(makeRevision())).toEqual(makeRevision());
  });

  it("accepts commit dates with any offset", () => {
    expect(ok({ commitDate: "2026-02-03T17:00:00+02:00" })).toBe(true);
    expect(ok({ commitDate: "2026-02-03T15:00:00Z" })).toBe(true);
  });

  it("rejects date-only and offset-less timestamps", () => {
    expect(ok({ commitDate: "2026-02-03" })).toBe(false);
    expect(ok({ commitDate: "2026-02-03T10:00:00" })).toBe(false);
  });

  it("requires the lead section first", () => {
    expect(
      ok({
        sections: [
          { key: "overview", claims: [bodyClaim()] },
          { key: "lead", claims: [leadClaim()] },
        ],
      }),
    ).toBe(false);
  });

  it("rejects duplicate section keys", () => {
    const overview = { key: "overview" as const, claims: [bodyClaim()] };
    expect(
      ok({
        sections: [
          { key: "lead", claims: [leadClaim()] },
          overview,
          { ...overview, claims: [bodyClaim({ id: "c-2" })] },
        ],
      }),
    ).toBe(false);
  });

  it("rejects duplicate claim ids across sections", () => {
    const sections = [
      { key: "lead" as const, claims: [leadClaim()] },
      { key: "overview" as const, claims: [bodyClaim()] },
      { key: "how-it-works" as const, claims: [bodyClaim()] },
    ];
    expect(ok({ sections })).toBe(false);
  });

  it("rejects lead claims that support unknown claims", () => {
    expect(
      ok({
        sections: [
          { key: "lead", claims: [leadClaim({ supports: ["ghost"] })] },
          { key: "overview", claims: [bodyClaim()] },
        ],
      }),
    ).toBe(false);
  });

  describe("parentId and reason", () => {
    const parentIssues = (overrides: Parameters<typeof makeRevision>[0]) => {
      const result = Revision.safeParse(makeRevision(overrides));
      return result.success
        ? []
        : result.error.issues.filter((i) => i.path.join(".") === "parentId").map((i) => i.message);
    };

    it("accepts a manifest-change revision with no parent (a newly created or split feature)", () => {
      expect(ok({ reason: "manifest-change", parentId: null })).toBe(true);
    });

    it("accepts a manifest-change revision with a parent", () => {
      expect(ok({ reason: "manifest-change", parentId: "rev-0" })).toBe(true);
    });

    it("accepts an update revision with a parent", () => {
      expect(ok({ reason: "update", parentId: "rev-0" })).toBe(true);
    });

    it("rejects a build revision with a parent", () => {
      expect(parentIssues({ reason: "build", parentId: "rev-0" })).toEqual([
        "build revisions have no parent",
      ]);
    });

    it("rejects an update revision without a parent", () => {
      expect(parentIssues({ reason: "update", parentId: null })).toEqual([
        "update revisions must have a parent",
      ]);
    });
  });

  it("rejects seeAlso pointing at the page itself", () => {
    expect(ok({ seeAlso: ["signals"] })).toBe(false);
  });
});
