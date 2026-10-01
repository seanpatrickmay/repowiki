import { describe, expect, it } from "vitest";
import type { Claim } from "./claim.ts";
import { claimRuleViolations, Section, type SectionKey } from "./section.ts";
import { bodyClaim, codeCitation, commitCitation, leadClaim } from "./test-fixtures.ts";

describe("claimRuleViolations", () => {
  const valid: Array<[SectionKey, Claim]> = [
    ["lead", leadClaim()],
    ["overview", bodyClaim()],
    ["how-it-works", bodyClaim({ citations: [codeCitation(), commitCitation()] })],
    ["history", bodyClaim({ kind: "history", citations: [commitCitation()] })],
    ["known-limitations", bodyClaim({ kind: "limitation" })],
  ];

  it.each(valid)("accepts a valid %s claim", (key, claim) => {
    expect(claimRuleViolations(key, claim)).toEqual([]);
  });

  const invalid: Array<[string, SectionKey, Claim, string]> = [
    [
      "lead with citations",
      "lead",
      leadClaim({ citations: [codeCitation()] }),
      "lead claims carry no citations",
    ],
    ["lead supporting nothing", "lead", leadClaim({ supports: [] }), "lead claims must support"],
    ["uncited body claim", "overview", bodyClaim({ citations: [] }), "at least one citation"],
    [
      "body claim with supports",
      "overview",
      bodyClaim({ supports: ["c-2"] }),
      "only lead claims may support",
    ],
    [
      "history without a commit",
      "history",
      bodyClaim({ kind: "history" }),
      "need a commit citation",
    ],
    [
      "limitation outside its section",
      "overview",
      bodyClaim({ kind: "limitation" }),
      "overview claims must be fact",
    ],
    [
      "fact in history",
      "history",
      bodyClaim({ citations: [commitCitation()] }),
      "history claims must be history",
    ],
  ];

  it.each(invalid)("rejects %s", (_name, key, claim, fragment) => {
    expect(claimRuleViolations(key, claim).join("; ")).toContain(fragment);
  });
});

describe("Section", () => {
  it("reports violations at the offending claim's path", () => {
    const result = Section.safeParse({
      key: "overview",
      claims: [bodyClaim({ citations: [] })],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["claims", 0]);
  });

  it("rejects empty sections", () => {
    expect(Section.safeParse({ key: "overview", claims: [] }).success).toBe(false);
  });

  it("rejects rendered-only keys", () => {
    expect(
      Section.safeParse({
        key: "references",
        claims: [bodyClaim()],
      } as unknown).success,
    ).toBe(false);
  });
});
