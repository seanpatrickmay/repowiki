import { describe, expect, it } from "vitest";
import { cleanAliases, type ManifestProposal, proposalProblems } from "./proposal.ts";

const clusters = ["c01", "c02", "c03"].map((id) => ({ id, files: [] }));

const API = { id: "http-api", title: "HTTP API", aliases: ["API server", "FastAPI app", "routes"] };
const WEB = {
  id: "web-frontend",
  title: "Web frontend",
  aliases: ["UI", "React app", "dashboard"],
};

function proposal(overrides: Partial<ManifestProposal> = {}): ManifestProposal {
  return {
    features: [API, WEB],
    clusters: [
      { cluster: "c01", feature: "http-api", role: "core" },
      { cluster: "c02", feature: "http-api", role: "supporting" },
      { cluster: "c03", feature: "web-frontend", role: "core" },
    ],
    ...overrides,
  };
}

describe("proposalProblems", () => {
  it("accepts a proposal that assigns every cluster once", () => {
    expect(proposalProblems(proposal(), clusters)).toEqual([]);
  });

  it.each([
    [
      "a bad slug",
      { features: [{ ...API, id: "HTTP_API" }, WEB] },
      'feature id "HTTP_API" is not a kebab-case slug of at most 40 characters',
    ],
    [
      "a slug over 40 characters",
      { features: [{ ...API, id: "a".repeat(41) }, WEB] },
      `feature id "${"a".repeat(41)}" is not a kebab-case slug of at most 40 characters`,
    ],
    [
      "a duplicate title",
      { features: [API, { ...WEB, title: "http api" }] },
      'title "http api" is used twice',
    ],
    [
      "too few distinct aliases",
      {
        features: [{ ...API, aliases: ["API", "api", "HTTP API"] }, WEB],
      },
      'feature "http-api" has 1 distinct aliases; give 3 to 8',
    ],
    [
      "a cluster assigned twice",
      {
        clusters: [
          ...proposal().clusters,
          { cluster: "c01", feature: "web-frontend", role: "core" },
        ],
      },
      "cluster c01 is assigned twice",
    ],
    [
      "an unassigned cluster",
      { clusters: proposal().clusters.slice(0, 2) },
      "cluster c03 is not assigned",
    ],
    [
      "an unknown cluster",
      { clusters: [...proposal().clusters, { cluster: "c09", feature: "http-api", role: "core" }] },
      "cluster c09 does not exist",
    ],
    [
      "an unknown feature",
      {
        clusters: [
          ...proposal().clusters.slice(0, 2),
          { cluster: "c03", feature: "frontend", role: "core" },
        ],
      },
      'cluster c03 is assigned to unknown feature "frontend"',
    ],
  ] as [string, Partial<ManifestProposal>, string][])("reports %s", (_name, overrides, problem) => {
    expect(proposalProblems(proposal(overrides), clusters)).toContain(problem);
  });
});

describe("proposalProblems edge cases", () => {
  const problems = (overrides: Partial<ManifestProposal>) =>
    proposalProblems(proposal(overrides), clusters);

  it("accepts a slug of exactly 40 characters", () => {
    const id = `a${"b".repeat(39)}`;
    const clusterEntries = proposal().clusters.map((c) =>
      c.feature === "http-api" ? { ...c, feature: id } : c,
    );
    expect(problems({ features: [{ ...API, id }, WEB], clusters: clusterEntries })).toEqual([]);
  });

  it("rejects slugs the core FeatureId schema rejects", () => {
    for (const id of ["", "-a", "a-", "a--b", "a b", "café", "A"]) {
      expect(problems({ features: [{ ...API, id }, WEB] })).toContain(
        `feature id "${id}" is not a kebab-case slug of at most 40 characters`,
      );
    }
  });

  it("reports a duplicate feature id", () => {
    expect(problems({ features: [API, { ...WEB, id: "http-api" }] })).toContain(
      'feature id "http-api" is used twice',
    );
  });

  it("reports an empty or whitespace-only title", () => {
    expect(problems({ features: [API, { ...WEB, title: " \t " }] })).toContain(
      'feature "web-frontend" has an empty title',
    );
  });

  it("compares titles case-insensitively and ignoring surrounding whitespace", () => {
    expect(problems({ features: [API, { ...WEB, title: "  hTtP aPi " }] })).toContain(
      'title "hTtP aPi" is used twice',
    );
    expect(
      problems({
        features: [
          { ...API, title: " http api " },
          { ...WEB, title: "HTTP API" },
        ],
      }),
    ).toContain('title "HTTP API" is used twice');
  });

  it("requires three distinct aliases, not two", () => {
    expect(problems({ features: [{ ...API, aliases: ["API server", "routes"] }, WEB] })).toContain(
      'feature "http-api" has 2 distinct aliases; give 3 to 8',
    );
  });

  it("does not count empty, whitespace-only, case-variant or title-equal aliases", () => {
    const aliases = ["", "   ", "API server", " api SERVER ", "  http api  ", "routes"];
    expect(problems({ features: [{ ...API, aliases }, WEB] })).toContain(
      'feature "http-api" has 2 distinct aliases; give 3 to 8',
    );
  });

  it("does not count an alias equal to a whitespace-padded title", () => {
    const feature = { ...API, title: "  HTTP API  ", aliases: ["http api", "a", "b"] };
    expect(problems({ features: [feature, WEB] })).toContain(
      'feature "http-api" has 2 distinct aliases; give 3 to 8',
    );
  });

  it("does not report more than 8 aliases or a feature with no clusters", () => {
    const many = Array.from({ length: 12 }, (_, i) => `alias ${i}`);
    const idle = { id: "idle", title: "Idle", aliases: ["x", "y", "z"] };
    expect(problems({ features: [{ ...API, aliases: many }, WEB, idle] })).toEqual([]);
  });

  it("reports every problem, not only the first", () => {
    const found = problems({
      features: [
        { ...API, id: "BAD" },
        { ...WEB, aliases: [] },
      ],
      clusters: [{ cluster: "c01", feature: "nope", role: "core" }],
    });
    expect(found).toEqual([
      'feature id "BAD" is not a kebab-case slug of at most 40 characters',
      'feature "web-frontend" has 0 distinct aliases; give 3 to 8',
      'cluster c01 is assigned to unknown feature "nope"',
      "cluster c02 is not assigned",
      "cluster c03 is not assigned",
    ]);
  });

  it("makes no assumption about the width of cluster ids", () => {
    const wide = Array.from({ length: 101 }, (_, i) => ({
      id: `c${String(i + 1).padStart(3, "0")}`,
      files: [],
    }));
    const assignments = wide.map((c) => ({
      cluster: c.id,
      feature: "http-api",
      role: "core" as const,
    }));
    expect(proposalProblems({ features: [API, WEB], clusters: assignments }, wide)).toEqual([]);
    expect(
      proposalProblems({ features: [API, WEB], clusters: assignments.slice(0, 100) }, wide),
    ).toEqual(["cluster c101 is not assigned"]);
    expect(proposalProblems({ features: [API, WEB], clusters: assignments }, clusters)).toContain(
      "cluster c001 does not exist",
    );
  });
});

describe("cleanAliases", () => {
  it("trims, drops empty and whitespace-only aliases, and keeps first-seen order", () => {
    expect(cleanAliases("Title", ["  b ", "", "   ", "a", "\tc\n"])).toEqual(["b", "a", "c"]);
  });

  it("de-duplicates case-insensitively and ignoring surrounding whitespace, keeping the first spelling", () => {
    expect(cleanAliases("Title", ["Foo Bar", " foo bar", "FOO BAR ", "baz"])).toEqual([
      "Foo Bar",
      "baz",
    ]);
  });

  it("drops aliases equal to the title, ignoring case and whitespace on both sides", () => {
    expect(cleanAliases("  HTTP API ", ["http api", " Http Api ", "api"])).toEqual(["api"]);
  });

  it("folds case with toLowerCase only: Unicode case folding is out of scope", () => {
    expect(cleanAliases("t", ["Straße", "STRASSE"])).toEqual(["Straße", "STRASSE"]);
    expect(cleanAliases("t", ["Ünï", "üNÏ"])).toEqual(["Ünï"]);
  });
});
