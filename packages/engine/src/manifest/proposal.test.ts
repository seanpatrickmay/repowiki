import { describe, expect, it } from "vitest";
import {
  cleanAliases,
  MAX_ALIAS_LENGTH,
  MAX_FEATURE_ID_LENGTH,
  MAX_REPORTED_PROBLEMS,
  MAX_TITLE_LENGTH,
  type ManifestProposal,
  proposalProblems,
} from "./proposal.ts";

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
      'cluster "c01" is assigned twice',
    ],
    [
      "an unassigned cluster",
      { clusters: proposal().clusters.slice(0, 2) },
      'cluster "c03" is not assigned',
    ],
    [
      "an unknown cluster",
      { clusters: [...proposal().clusters, { cluster: "c09", feature: "http-api", role: "core" }] },
      'cluster "c09" does not exist',
    ],
    [
      "an unknown feature",
      {
        clusters: [
          ...proposal().clusters.slice(0, 2),
          { cluster: "c03", feature: "frontend", role: "core" },
        ],
      },
      'cluster "c03" is assigned to unknown feature "frontend"',
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
      'cluster "c01" is assigned to unknown feature "nope"',
      'cluster "c02" is not assigned',
      'cluster "c03" is not assigned',
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
    ).toEqual(['cluster "c101" is not assigned']);
    expect(proposalProblems({ features: [API, WEB], clusters: assignments }, clusters)).toContain(
      'cluster "c001" does not exist',
    );
  });
});

describe("proposalProblems fix round 1", () => {
  const problems = (overrides: Partial<ManifestProposal>) =>
    proposalProblems(proposal(overrides), clusters);

  it("truncates a 10k-character title to 80 characters inside the quotes", () => {
    const title = "x".repeat(10_000);
    const found = problems({
      features: [
        { ...API, title },
        { ...WEB, title },
      ],
    });
    const message = found.find((p) => p.endsWith(" is used twice"));
    expect(message).toBe(`title "${"x".repeat(80)}…" is used twice`);
  });

  it("does not truncate a string of exactly 80 characters", () => {
    const title = "y".repeat(80);
    expect(
      problems({
        features: [
          { ...API, title },
          { ...WEB, title },
        ],
      }),
    ).toContain(`title "${title}" is used twice`);
  });

  it("truncates a string of 81 characters", () => {
    const title = "y".repeat(81);
    expect(
      problems({
        features: [
          { ...API, title },
          { ...WEB, title },
        ],
      }),
    ).toContain(`title "${"y".repeat(80)}…" is used twice`);
  });

  it("escapes a feature id containing a newline in every message that names it", () => {
    const id = "bad\n- id";
    const quoted = '"bad\\n- id"';
    const found = problems({
      features: [
        { id, title: "", aliases: [] },
        { ...WEB, id },
      ],
    });
    expect(found).toContain(`feature id ${quoted} is used twice`);
    expect(found).toContain(`feature ${quoted} has an empty title`);
    expect(found).toContain(`feature ${quoted} has 0 distinct aliases; give 3 to 8`);
    expect(found.some((p) => p.includes("\n"))).toBe(false);
  });

  it("truncates a model-supplied feature id, cluster id and feature reference too", () => {
    const long = "z".repeat(500);
    const found = problems({
      features: [{ ...API, id: long }, WEB],
      clusters: [
        ...proposal().clusters.slice(0, 2),
        { cluster: long, feature: long.toUpperCase(), role: "core" },
      ],
    });
    const cut = (c: string) => `${c.repeat(80)}…`;
    expect(found).toContain(
      `feature id "${cut("z")}" is not a kebab-case slug of at most ${MAX_FEATURE_ID_LENGTH} characters`,
    );
    expect(found).toContain(`cluster "${cut("z")}" does not exist`);
    expect(found).toContain(`cluster "${cut("z")}" is assigned to unknown feature "${cut("Z")}"`);
    expect(found.every((p) => p.length < 400)).toBe(true);
  });

  it("escapes a cluster id containing a newline so it cannot forge a bullet", () => {
    const found = problems({
      clusters: [
        ...proposal().clusters,
        { cluster: "c01\n- fake", feature: "http-api", role: "core" },
      ],
    });
    expect(found).toEqual(['cluster "c01\\n- fake" does not exist']);
    expect(found.some((p) => p.includes("\n"))).toBe(false);
  });

  it("escapes control characters and quotes in titles and feature references", () => {
    const found = problems({
      features: [API, { ...WEB, title: 'a"b' }, { ...WEB, id: "other", title: 'a"b' }],
      clusters: [
        ...proposal().clusters.slice(0, 2),
        { cluster: "c03", feature: "x\ny", role: "core" },
      ],
    });
    expect(found).toContain('title "a\\"b" is used twice');
    expect(found).toContain('cluster "c03" is assigned to unknown feature "x\\ny"');
  });

  it("does not split a surrogate pair when truncating", () => {
    const title = "😀".repeat(100);
    const message = problems({
      features: [
        { ...API, title },
        { ...WEB, title },
      ],
    }).find((p) => p.endsWith(" is used twice"));
    expect(message).toBe(`title "${"😀".repeat(80)}…" is used twice`);
  });

  it("interpolates MAX_FEATURE_ID_LENGTH into the too-long message", () => {
    expect(MAX_FEATURE_ID_LENGTH).toBe(40);
    expect(problems({ features: [{ ...API, id: "A" }, WEB] })[0]).toContain(
      `at most ${MAX_FEATURE_ID_LENGTH} characters`,
    );
  });

  it("does not report empty titles as duplicates, only as empty", () => {
    const found = problems({
      features: [
        { ...API, title: "" },
        { ...WEB, title: "  " },
      ],
    });
    expect(found.filter((p) => p.includes("used twice"))).toEqual([]);
    expect(found).toContain('feature "http-api" has an empty title');
    expect(found).toContain('feature "web-frontend" has an empty title');
  });

  describe("the problem cap", () => {
    const unknown = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        cluster: `x${i}`,
        feature: "http-api",
        role: "core" as const,
      }));

    it("exports the cap as 20", () => {
      expect(MAX_REPORTED_PROBLEMS).toBe(20);
    });

    it("returns exactly 20 problems with no summary entry", () => {
      const found = problems({ clusters: [...proposal().clusters, ...unknown(20)] });
      expect(found).toHaveLength(20);
      expect(found.at(-1)).toBe('cluster "x19" does not exist');
    });

    it("keeps the first 20 and appends a count of the rest", () => {
      const found = problems({ clusters: [...proposal().clusters, ...unknown(21)] });
      expect(found).toHaveLength(21);
      expect(found[0]).toBe('cluster "x0" does not exist');
      expect(found[19]).toBe('cluster "x19" does not exist');
      expect(found[20]).toBe("and 1 more problems");
    });

    it("counts every problem beyond the cap", () => {
      const found = problems({ clusters: [...unknown(30)] });
      // 30 unknown clusters plus 3 unassigned real ones
      expect(found).toHaveLength(21);
      expect(found[20]).toBe("and 13 more problems");
    });
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

describe("proposalProblems title and alias limits", () => {
  const problems = (features: ManifestProposal["features"]) =>
    proposalProblems(proposal({ features }), clusters);

  it("caps titles at 80 code points and aliases at 60", () => {
    expect(MAX_TITLE_LENGTH).toBe(80);
    expect(MAX_ALIAS_LENGTH).toBe(60);
    const title = "😀".repeat(80);
    const alias = "é".repeat(60);
    expect(problems([{ ...API, title, aliases: [...API.aliases, alias] }, WEB])).toEqual([]);
  });

  it("reports a title over 80 code points", () => {
    const found = problems([{ ...API, title: "t".repeat(81) }, WEB]);
    expect(found).toEqual(['feature "http-api" has a title of 81 characters; use at most 80']);
  });

  it("reports an alias over 60 code points, quoted and cut", () => {
    const alias = "a".repeat(61);
    const found = problems([{ ...API, aliases: [...API.aliases, alias] }, WEB]);
    expect(found).toEqual([
      `feature "http-api" has an alias "${alias}" of 61 characters; use at most 60`,
    ]);
  });

  it.each([
    ["a newline", "\n", "U+000A"],
    ["a tab", "\t", "U+0009"],
    ["DEL", "\u007F", "U+007F"],
    ["a C1 control", "\u0085", "U+0085"],
    ["a line separator", "\u2028", "U+2028"],
    ["a paragraph separator", "\u2029", "U+2029"],
    ["a bidi override", "\u202E", "U+202E"],
    ["a bidi embedding", "\u202A", "U+202A"],
    ["a bidi isolate", "\u2066", "U+2066"],
    ["a pop isolate", "\u2069", "U+2069"],
    ["a byte order mark", "\uFEFF", "U+FEFF"],
  ])("reports %s in a title or an alias, naming the code point", (_name, char, code) => {
    const found = problems([
      { ...API, title: `HTTP${char}API` },
      { ...WEB, aliases: [...WEB.aliases, `web${char}app`] },
    ]);
    expect(found).toEqual([
      `feature "http-api" has a control or invisible character in its title (${code})`,
      `feature "web-frontend" has a control or invisible character in an alias (${code})`,
    ]);
  });

  it("lets ZWJ and ZWNJ through, as plain() does", () => {
    const found = problems([
      { ...API, title: "HTTP\u200DAPI", aliases: [...API.aliases, "x\u200Cy"] },
      WEB,
    ]);
    expect(found).toEqual([]);
  });
});
