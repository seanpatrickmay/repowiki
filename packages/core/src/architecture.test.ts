import { describe, expect, it } from "vitest";
import {
  Architecture,
  ArchitectureClaim,
  ArchitectureSection,
  type ArchitectureSectionKey,
  architectureClaimViolations,
  FeatureEdge,
} from "./architecture.ts";
import {
  architectureClaim,
  codeCitation,
  leadClaim,
  makeArchitecture,
  SHA_B,
} from "./test-fixtures.ts";

const lead = (overrides: Partial<ArchitectureClaim> = {}): ArchitectureClaim => ({
  ...leadClaim({ supports: ["a-1"] }),
  pages: [],
  ...overrides,
});

describe("architectureClaimViolations", () => {
  const valid: [string, ArchitectureSectionKey, ArchitectureClaim][] = [
    ["a lead", "lead", lead()],
    ["a cited claim", "layers", architectureClaim()],
    [
      "a page-backed claim",
      "dependencies",
      architectureClaim({ citations: [], pages: ["signals"] }),
    ],
    ["a claim with both", "infrastructure", architectureClaim({ pages: ["signals"] })],
    ["a cited request path", "request-paths", architectureClaim()],
  ];
  it.each(valid)("accepts %s", (_name, key, claim) => {
    expect(architectureClaimViolations(key, claim)).toEqual([]);
  });

  const invalid: [string, ArchitectureSectionKey, ArchitectureClaim, string][] = [
    ["a lead with a citation", "lead", lead({ citations: [codeCitation()] }), "carry no citations"],
    ["a lead with a page", "lead", lead({ pages: ["signals"] }), "carry no citations or pages"],
    ["a lead supporting nothing", "lead", lead({ supports: [] }), "must support"],
    [
      "a body claim with neither",
      "layers",
      architectureClaim({ citations: [] }),
      "need a citation or a feature page",
    ],
    [
      "a request path backed by a page only",
      "request-paths",
      architectureClaim({ citations: [], pages: ["signals"] }),
      "request-path claims need a code or commit citation",
    ],
    [
      "a body claim with supports",
      "layers",
      architectureClaim({ supports: ["a-2"] }),
      "only lead claims may support",
    ],
    [
      "a page named twice",
      "dependencies",
      architectureClaim({ pages: ["signals", "signals"] }),
      "the same page twice",
    ],
    ["a history claim", "layers", architectureClaim({ kind: "history" }), "must be fact claims"],
  ];
  it.each(invalid)("refuses %s", (_name, key, claim, message) => {
    expect(architectureClaimViolations(key, claim).join("; ")).toContain(message);
  });

  it.each(invalid)("refuses %s when the section is parsed", (_name, key, claim, message) => {
    const result = ArchitectureSection.safeParse({ key, claims: [claim] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("; ")).toContain(message);
  });

  it.each(valid)("accepts %s when the section is parsed", (_name, key, claim) => {
    expect(ArchitectureSection.safeParse({ key, claims: [claim] }).success).toBe(true);
  });

  it("refuses rule-breaking claims inside a whole article", () => {
    const [first] = makeArchitecture().sections;
    const sections = [first, { key: "layers", claims: [architectureClaim({ citations: [] })] }];
    const result = Architecture.safeParse(makeArchitecture({ sections: sections as never }));
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "body claims need a citation or a feature page",
    ]);
  });
});

describe("ArchitectureClaim", () => {
  it("refuses a page named twice on its own", () => {
    const parse = (pages: string[]) => ArchitectureClaim.safeParse(architectureClaim({ pages }));
    expect(parse(["signals", "deliverables"]).success).toBe(true);
    expect(parse(["signals", "signals"]).success).toBe(false);
  });
});

const ok = (overrides: Partial<Architecture>) =>
  Architecture.safeParse(makeArchitecture(overrides)).success;
const messagesOf = (overrides: Partial<Architecture>): string[] =>
  Architecture.safeParse(makeArchitecture(overrides)).error?.issues.map((i) => i.message) ?? [];

describe("Architecture", () => {
  it("accepts the fixture article", () => {
    expect(Architecture.parse(makeArchitecture())).toEqual(makeArchitecture());
  });

  it("requires the lead first, unique sections and claim ids, and known supports", () => {
    const [first, layers, dependencies] = makeArchitecture().sections as [
      Architecture["sections"][number],
      Architecture["sections"][number],
      Architecture["sections"][number],
    ];
    expect(messagesOf({ sections: [layers, first] })).toEqual([
      "the first section must be the lead",
    ]);
    const twice = { ...layers, claims: [architectureClaim({ id: "a-3" })] };
    expect(messagesOf({ sections: [first, layers, twice] })).toEqual(["duplicate section layers"]);
    const again = { ...dependencies, claims: [architectureClaim()] };
    expect(messagesOf({ sections: [first, layers, again] })).toEqual(["duplicate claim id a-1"]);
    expect(messagesOf({ sections: [first, dependencies] })).toEqual([
      "lead claim lead-1 supports unknown body claim a-1",
    ]);
  });

  it("names its id architecture-<sha12>-<n>, with the sha12 of its own sha", () => {
    expect(ok({ id: "architecture-aaaaaaaaaaaa-12" })).toBe(true);
    expect(ok({ id: "architecture-1" })).toBe(false);
    expect(ok({ id: "architecture-aaaaaaaaaaaa-0" })).toBe(false);
    expect(ok({ id: "architecture-aaaaaaaaaaaa-01" })).toBe(false);
    expect(ok({ id: "signals-aaaaaaaaaaaa-1" })).toBe(false);
    expect(messagesOf({ id: "architecture-bbbbbbbbbbbb-1" })).toEqual([
      "the id must carry the first 12 characters of the sha",
    ]);
    expect(ok({ id: "architecture-bbbbbbbbbbbb-1", sha: SHA_B })).toBe(true);
  });

  it("lists its basis sorted, without repeats", () => {
    expect(ok({ basis: ["a-1", "b-1"] })).toBe(true);
    expect(ok({ basis: ["b-1", "a-1"] })).toBe(false);
    expect(ok({ basis: ["a-1", "a-1"] })).toBe(false);
    expect(messagesOf({ basis: ["b-1", "a-1"] })).toEqual(["basis must be sorted without repeats"]);
  });

  it("lists its edges heaviest first", () => {
    const heavy = { from: "deliverables", to: "signals", imports: 1, calls: 2 };
    const light = { from: "signals", to: "deliverables", imports: 1, calls: 0 };
    const equal = { from: "signals", to: "billing", imports: 0, calls: 3 };
    expect(ok({ edges: [heavy, light] })).toBe(true);
    expect(ok({ edges: [heavy, equal] })).toBe(true);
    expect(messagesOf({ edges: [light, heavy] })).toEqual(["edges must be heaviest first"]);
  });

  it("refuses more than three pages on a claim and a page id that is not a feature id", () => {
    const pages = (ids: string[]) => [
      makeArchitecture().sections[0] as Architecture["sections"][number],
      { key: "dependencies" as const, claims: [architectureClaim({ id: "a-1", pages: ids })] },
    ];
    expect(ok({ sections: pages(["a", "b", "c"]) })).toBe(true);
    expect(ok({ sections: pages(["a", "b", "c", "d"]) })).toBe(false);
    expect(ok({ sections: pages(["../etc"]) })).toBe(false);
  });

  it("refuses a self edge, an empty edge and a repeated edge", () => {
    expect(FeatureEdge.safeParse({ from: "a", to: "a", imports: 1, calls: 0 }).success).toBe(false);
    expect(FeatureEdge.safeParse({ from: "a", to: "b", imports: 0, calls: 0 }).success).toBe(false);
    const edge = { from: "deliverables", to: "signals", imports: 1, calls: 0 };
    expect(ok({ edges: [edge, edge] })).toBe(false);
    expect(ok({ edges: [edge, { ...edge, from: "signals", to: "deliverables" }] })).toBe(true);
  });

  it("needs a parent on an update and allows one on a rebuilt article", () => {
    expect(ok({ reason: "update" })).toBe(false);
    expect(ok({ reason: "update", parentId: "architecture-0" })).toBe(true);
    expect(ok({ reason: "build", parentId: "architecture-0" })).toBe(true);
  });
});
