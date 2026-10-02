import { describe, expect, it } from "vitest";
import {
  Architecture,
  type ArchitectureClaim,
  type ArchitectureSectionKey,
  architectureClaimViolations,
  FeatureEdge,
} from "./architecture.ts";
import { architectureClaim, codeCitation, leadClaim, makeArchitecture } from "./test-fixtures.ts";

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
});

const ok = (overrides: Partial<Architecture>) =>
  Architecture.safeParse(makeArchitecture(overrides)).success;

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
    expect(ok({ sections: [layers, first] })).toBe(false);
    expect(ok({ sections: [first, layers, layers] })).toBe(false);
    const again = { ...dependencies, claims: [architectureClaim()] };
    expect(ok({ sections: [first, layers, again] })).toBe(false);
    expect(ok({ sections: [first, dependencies] })).toBe(false);
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
