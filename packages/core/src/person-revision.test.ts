import { describe, expect, it } from "vitest";
import {
  featureLinkTargets,
  PersonRevision,
  type PersonSectionKey,
  personClaimViolations,
} from "./person.ts";
import {
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makePersonRevision,
} from "./test-fixtures.ts";

const chronicle = (overrides = {}) =>
  bodyClaim({ id: "c1", kind: "history", citations: [commitCitation()], ...overrides });
const areas = (overrides = {}) =>
  bodyClaim({ id: "a1", text: "[[signals]]: x.", citations: [commitCitation()], ...overrides });

describe("featureLinkTargets", () => {
  it("reads [[id]] and [[id|words]] tokens, skipping wp: links and code spans", () => {
    expect(featureLinkTargets("[[signals]] and [[deliverables|the deliverables]]")).toEqual([
      "signals",
      "deliverables",
    ]);
    expect(featureLinkTargets("[[wp:Queue]] and `[[signals]]`")).toEqual([]);
  });
});

describe("personClaimViolations (spec v2 #6 §5 rule 1)", () => {
  const cases: [PersonSectionKey, Parameters<typeof personClaimViolations>[1], string][] = [
    ["lead", leadClaim({ citations: [commitCitation()] }), "lead claims carry no citations"],
    ["lead", leadClaim({ supports: [] }), "must support at least one body claim"],
    ["chronicle", chronicle({ kind: "fact" }), "chronicle claims must be history claims"],
    ["chronicle", chronicle({ citations: [] }), "chronicle claims need a commit citation"],
    ["chronicle", chronicle({ citations: [codeCitation()] }), "cite commits only"],
    ["chronicle", chronicle({ hook: true }), "never Main Page hooks"],
    ["chronicle", chronicle({ supports: ["a1"] }), "only lead claims may support"],
    ["areas", areas({ kind: "limitation" }), "areas claims must be fact claims"],
    ["areas", areas({ text: "No link." }), "links exactly one feature"],
    ["areas", areas({ text: "[[signals]] and [[deliverables]]" }), "links exactly one feature"],
  ];
  for (const [key, claim, problem] of cases) {
    it(`refuses a ${key} claim: ${problem}`, () => {
      expect(personClaimViolations(key, claim).join("; ")).toContain(problem);
    });
  }

  it("accepts the fixture's claims", () => {
    for (const section of makePersonRevision().sections)
      for (const claim of section.claims)
        expect(personClaimViolations(section.key, claim)).toEqual([]);
  });
});

describe("PersonRevision", () => {
  it("accepts the fixture", () => {
    expect(PersonRevision.parse(makePersonRevision())).toEqual(makePersonRevision());
  });

  it("refuses an id for another person or sha, sections out of order, and a parentless update", () => {
    const [lead, chron, area] = makePersonRevision().sections;
    const bad = [
      makePersonRevision({ id: "person-grace-hopper-aaaaaaaaaaaa-1" }),
      makePersonRevision({ id: "person-ada-lovelace-bbbbbbbbbbbb-1" }),
      makePersonRevision({ id: "ada-lovelace-1" }),
      makePersonRevision({ sections: [lead, area, chron] as never }),
      makePersonRevision({ sections: [chron, lead] as never }),
      makePersonRevision({ reason: "update" }),
    ];
    for (const revision of bad) expect(PersonRevision.safeParse(revision).success).toBe(false);
  });

  it("accepts a whole rewrite that continues a chain", () => {
    const revision = makePersonRevision({
      id: "person-ada-lovelace-aaaaaaaaaaaa-2",
      parentId: "x",
    });
    expect(PersonRevision.safeParse(revision).success).toBe(true);
    expect(PersonRevision.safeParse({ ...revision, reason: "update" }).success).toBe(true);
  });
});
