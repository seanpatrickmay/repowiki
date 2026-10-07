import { describe, expect, it } from "vitest";
import {
  GitHubSnapshot,
  githubBlobUrl,
  githubUrl,
  INFLIGHT_PATH_MAX_LENGTH,
  InFlight,
  InFlightFile,
  InFlightPull,
  inflightBody,
  inflightLine,
  isInflightPath,
} from "./inflight.ts";
import { LedgerEntry, LlmConfigFile, LlmRole, RunKind } from "./llm.ts";
import {
  DEMO_REPO,
  makeGitHubIssue,
  makeGitHubPull,
  makeGitHubSnapshot,
  makeInFlight,
  makeInFlightIssue,
  makeInFlightPull,
  makeLedgerEntry,
  SHA_A,
  SHA_C,
} from "./test-fixtures.ts";

const paths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((i) => i.path.map(String).join("."));

describe("inflightLine", () => {
  it("makes one line of control, line-break and bidi characters, and collapses whitespace", () => {
    expect(inflightLine("Fix\nthe\u0085\u2028 parser\t\u202Eexe.txt\u202C  now ", 200)).toBe(
      "Fix the parser exe.txt now",
    );
  });

  it("cuts at max code points with an ellipsis, never splitting an astral character", () => {
    expect(inflightLine("abcdef", 6)).toBe("abcdef");
    expect(inflightLine("abcdefg", 6)).toBe("abcde…");
    expect(inflightLine("\u{1F600}".repeat(5), 3)).toBe("\u{1F600}\u{1F600}…");
    expect(inflightLine("abc   defg", 5)).toBe("abc…");
  });

  it("blanks fillers that render as nothing, and makes a lone surrogate well formed", () => {
    for (const filler of [
      "\u034F",
      "\u115F",
      "\u1160",
      "\u2800",
      "\u3164",
      "\uFFA0",
      "\uFE0F",
      "\uFFFC",
    ])
      expect(inflightLine(`a${filler}b`, 200), JSON.stringify(filler)).toBe("a b");
    expect(inflightLine("\u3164\u3164", 200)).toBe("");
    expect(inflightLine("a\uD800b", 200)).toBe("a\uFFFDb");
    expect(inflightBody("a\uD800\u3164b")).toBe("a\uFFFD b");
  });

  it("escapes nothing, and gives the same line again for its own output", () => {
    const hostile = "<script>alert(1)</script> [[signals]] `x` [a](javascript:x)";
    expect(inflightLine(hostile, 200)).toBe(hostile);
    for (const text of ["a\n\nb", "x".repeat(300), " \u200B y \u2066z"]) {
      const once = inflightLine(text, 50);
      expect(inflightLine(once, 50)).toBe(once);
    }
  });
});

describe("inflightBody", () => {
  it("replaces every invisible character with a space and cuts to 4,000 code points", () => {
    expect(inflightBody("line one\nline two\u202E")).toBe("line one line two ");
    expect([...inflightBody("\u{1F600}".repeat(5000))]).toHaveLength(4000);
  });
});

describe("GitHub URLs", () => {
  it("builds a pull request's and an issue's page from the repo and number alone", () => {
    expect(githubUrl(DEMO_REPO, "pull", 12)).toBe("https://github.com/acme/demo/pull/12");
    expect(githubUrl(DEMO_REPO, "issues", 7)).toBe("https://github.com/acme/demo/issues/7");
  });

  it("encodes the commit too, so no string can change a blob link's shape", () => {
    expect(githubBlobUrl(DEMO_REPO, "a/../b?c", "a.py", 1, 1)).toBe(
      "https://github.com/acme/demo/blob/a%2F..%2Fb%3Fc/a.py#L1",
    );
  });

  it("links a file's lines at a commit with percent-encoded path segments", () => {
    expect(githubBlobUrl(DEMO_REPO, SHA_C, "src/a b/#x?.py", 3, 9)).toBe(
      `https://github.com/acme/demo/blob/${SHA_C}/src/a%20b/%23x%3F.py#L3-L9`,
    );
    expect(githubBlobUrl(DEMO_REPO, SHA_C, "a.py", 4, 4)).toBe(
      `https://github.com/acme/demo/blob/${SHA_C}/a.py#L4`,
    );
  });
});

describe("InFlight", () => {
  it("accepts the fixture snapshot", () => {
    expect(InFlight.parse(makeInFlight())).toEqual(makeInFlight());
  });

  it.each([
    ["a title with a newline", { title: "Fix\nit" }],
    ["a title with a bidi override", { title: "\u202Eexe.txt" }],
    ["an over-long title", { title: "x".repeat(201) }],
    ["an empty title", { title: "" }],
    ["a label with a tab", { labels: ["area:\tsignals"] }],
    ["eleven labels", { labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }],
    ["a base branch with a newline", { baseRef: "main\nx" }],
    ["a login with an @", { author: { login: "a@b.c", bot: false } }],
    ["a login of 40 characters", { author: { login: "a".repeat(40), bot: false } }],
  ])("refuses a pull request with %s", (_name, overrides) => {
    expect(InFlightPull.safeParse(makeInFlightPull(overrides)).success).toBe(false);
  });

  it("accepts a deleted author as null", () => {
    expect(InFlightPull.safeParse(makeInFlightPull({ author: null })).success).toBe(true);
  });

  it("accepts a pull request at each bound: a 200-character title, ten labels, 50 pulls", () => {
    const bounded = makeInFlightPull({
      title: "x".repeat(200),
      labels: Array.from({ length: 10 }, (_, i) => `l${i}`),
    });
    expect(InFlightPull.safeParse(bounded).success).toBe(true);
    const fifty = makeInFlight({
      pulls: Array.from({ length: 50 }, (_, i) => makeInFlightPull({ number: i + 1, closes: [] })),
      issues: [],
    });
    expect(InFlight.safeParse(fifty).success).toBe(true);
  });

  it("carries why the wiki is behind a pull request: one reason, never on an unfetched head (R27)", () => {
    const behind = (reason: unknown, overrides = {}) =>
      InFlightPull.safeParse(
        makeInFlightPull({
          behind: reason as never,
          effects: makeInFlightPull().effects.map((e) => ({ ...e, certain: false })),
          merge: "unknown",
          ...overrides,
        }),
      );
    expect(behind("wiki-behind").success).toBe(true);
    expect(behind("stacked").success).toBe(true);
    expect(
      behind("base-unread", { mergeBase: null, files: [], summary: null, baseSha: null }).success,
    ).toBe(true);
    expect(behind(null).success).toBe(true);
    // The reason, not a flag: an old boolean is refused, and so is an unknown reason.
    expect(behind(true).success).toBe(false);
    expect(behind("behind").success).toBe(false);
    // A stored body from before R27 has none.
    const { behind: _, ...old } = makeInFlightPull();
    expect(InFlightPull.parse(old).behind).toBeNull();
    // A base read has a fork point; a base not read has none, and lists GitHub's files only.
    expect(paths(behind("stacked", { mergeBase: null }))).toContain("mergeBase");
    expect(paths(behind("base-unread"))).toEqual(
      expect.arrayContaining(["mergeBase", "files", "summary"]),
    );
    expect(
      paths(
        InFlightPull.safeParse(
          makeInFlightPull({
            head: "moved",
            files: [],
            effects: [],
            merge: "unknown",
            summary: null,
            behind: "stacked",
          }),
        ),
      ),
    ).toEqual(["behind"]);
    expect(
      paths(InFlightPull.safeParse(makeInFlightPull({ behind: "wiki-behind", merge: "unknown" }))),
    ).toEqual(["effects"]);
  });

  it("lists no file, effect, merge or summary for a pull request whose head it lacks", () => {
    const missing = makeInFlightPull({ head: "missing" });
    expect(paths(InFlightPull.safeParse(missing))).toEqual([
      "files",
      "effects",
      "merge",
      "summary",
    ]);
    const bare = makeInFlightPull({
      head: "moved",
      files: [],
      effects: [],
      merge: "unknown",
      summary: null,
    });
    expect(InFlightPull.safeParse(bare).success).toBe(true);
  });

  it("requires summary claims to cite the head and name touched features only", () => {
    const pull = makeInFlightPull();
    const [claim] = pull.summary?.claims ?? [];
    if (claim === undefined || pull.summary === null) throw new Error("fixture has a claim");
    const cited = makeInFlightPull({
      summary: {
        ...pull.summary,
        claims: [{ ...claim, citations: [{ ...claim.citations[0], sha: SHA_A } as never] }],
      },
    });
    expect(paths(InFlightPull.safeParse(cited))).toEqual(["summary.claims.0.citations.0"]);
    const named = makeInFlightPull({
      summary: { ...pull.summary, claims: [{ ...claim, features: ["deliverables"] }] },
    });
    expect(paths(InFlightPull.safeParse(named))).toEqual(["summary.claims.0.features"]);
  });

  it("keeps a pull request's closes and an issue's pulls in agreement both ways", () => {
    const unlisted = makeInFlight({ issues: [makeInFlightIssue({ pulls: [] })] });
    expect(paths(InFlight.safeParse(unlisted))).toEqual(["pulls.0.closes"]);
    const unclosed = makeInFlight({ pulls: [makeInFlightPull({ closes: [] })] });
    expect(paths(InFlight.safeParse(unclosed))).toEqual(["issues.0.pulls"]);
  });

  it("refuses two pull requests or two issues with one number", () => {
    const pull = makeInFlightPull();
    const twice = makeInFlight({ pulls: [pull, pull] });
    expect(paths(InFlight.safeParse(twice))).toContain("pulls");
    const issue = makeInFlightIssue();
    const issues = makeInFlight({ issues: [issue, issue] });
    expect(paths(InFlight.safeParse(issues))).toContain("issues");
  });

  it.each([
    [
      "a feature listed twice",
      { features: [...makeInFlightPull().features, ...makeInFlightPull().features] },
      "features",
    ],
    ["an issue closed twice", { closes: [7, 7] }, "closes"],
    [
      "one claim's effect twice",
      { effects: [...makeInFlightPull().effects, makeInFlightPull().effects[0]] },
      "effects",
    ],
  ])("refuses a pull request with %s", (_name, overrides, path) => {
    expect(paths(InFlightPull.safeParse(makeInFlightPull(overrides as never)))).toContain(path);
  });

  it("refuses an issue listing one closing pull request twice", () => {
    const issue = makeInFlightIssue({ pulls: [12, 12] });
    expect(paths(InFlight.safeParse(makeInFlight({ issues: [issue] })))).toContain(
      "issues.0.pulls",
    );
  });

  it.each([
    [
      "51 pull requests",
      {
        pulls: Array.from({ length: 51 }, (_, i) =>
          makeInFlightPull({ number: i + 1, closes: [] }),
        ),
        issues: [],
      },
    ],
    ["a repository named .", { repo: { ...DEMO_REPO, name: "." } }],
    ["an uppercase wiki head", { wikiHead: SHA_A.toUpperCase() }],
  ])("refuses a snapshot with %s", (_name, overrides) => {
    expect(InFlight.safeParse(makeInFlight(overrides as never)).success).toBe(false);
  });

  it("refuses a feature named twice by one issue", () => {
    const evidence = { featureId: "signals", kind: "name" as const, detail: "signals" };
    const issue = makeInFlightIssue({ features: [evidence, { ...evidence, kind: "label" }] });
    expect(InFlight.safeParse(makeInFlight({ issues: [issue] })).success).toBe(false);
  });
});

describe("InFlightFile", () => {
  it("has a feature unless its placement is none", () => {
    const file = makeInFlightPull().files[0];
    expect(InFlightFile.safeParse({ ...file, featureId: null }).success).toBe(false);
    expect(InFlightFile.safeParse({ ...file, featureId: null, placement: "none" }).success).toBe(
      true,
    );
    expect(InFlightFile.safeParse({ ...file, path: "../etc/passwd" }).success).toBe(false);
    for (const path of ["a\tb.py", "a\u202Eb.py", "a\nb.py"]) {
      expect(InFlightFile.safeParse({ ...file, path }).success).toBe(false);
      expect(InFlightFile.safeParse({ ...file, oldPath: path }).success).toBe(false);
    }
  });
});

describe("GitHubSnapshot", () => {
  it("accepts the fixture snapshot", () => {
    expect(GitHubSnapshot.parse(makeGitHubSnapshot())).toEqual(makeGitHubSnapshot());
  });

  it.each([
    ["a 201-character title", { title: "x".repeat(201) }],
    ["eleven labels", { labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }],
    ["a bidi override in its title", { title: "\u202Eexe.txt" }],
    ["a bidi override in a label", { labels: ["area:\u2066signals"] }],
    ["a login with an @", { author: { login: "a@b.c", bot: false } }],
    ["a login of 40 characters", { author: { login: "a".repeat(40), bot: false } }],
    ["an uppercase head", { headRefOid: SHA_C.toUpperCase() }],
    ["a base oid that is not a sha", { baseRefOid: "main" }],
  ])("refuses a pull request or an issue with %s", (_name, overrides) => {
    const pull = makeGitHubSnapshot({ pulls: [makeGitHubPull(overrides as never)] });
    expect(GitHubSnapshot.safeParse(pull).success).toBe(false);
    if ("headRefOid" in overrides || "baseRefOid" in overrides) return;
    const issue = makeGitHubSnapshot({ issues: [makeGitHubIssue(overrides as never)] });
    expect(GitHubSnapshot.safeParse(issue).success).toBe(false);
  });

  it("accepts a pull request and an issue at each bound, and a deleted author as null", () => {
    const bounds = {
      title: "x".repeat(200),
      labels: Array.from({ length: 10 }, (_, i) => `l${i}`),
      author: null,
    };
    const snapshot = makeGitHubSnapshot({
      pulls: [makeGitHubPull(bounds)],
      issues: [makeGitHubIssue(bounds)],
    });
    expect(GitHubSnapshot.safeParse(snapshot).success).toBe(true);
    const fifty = makeGitHubSnapshot({
      pulls: Array.from({ length: 50 }, (_, i) => makeGitHubPull({ number: i + 1 })),
      issues: [],
    });
    expect(GitHubSnapshot.safeParse(fifty).success).toBe(true);
    const fiftyOne = makeGitHubSnapshot({
      pulls: Array.from({ length: 51 }, (_, i) => makeGitHubPull({ number: i + 1 })),
      issues: [],
    });
    expect(GitHubSnapshot.safeParse(fiftyOne).success).toBe(false);
  });

  it("refuses two pull requests or two issues with one number", () => {
    const pull = makeGitHubPull();
    expect(GitHubSnapshot.safeParse(makeGitHubSnapshot({ pulls: [pull, pull] })).success).toBe(
      false,
    );
    const issue = makeGitHubIssue();
    expect(GitHubSnapshot.safeParse(makeGitHubSnapshot({ issues: [issue, issue] })).success).toBe(
      false,
    );
  });

  it("refuses a pull request listing one closed issue or one path twice", () => {
    for (const pull of [
      makeGitHubPull({ closes: [7, 7] }),
      makeGitHubPull({ files: ["a.py", "a.py"] }),
    ])
      expect(GitHubSnapshot.safeParse(makeGitHubSnapshot({ pulls: [pull] })).success).toBe(false);
  });

  it("refuses a body that still holds a newline or a bidi control", () => {
    for (const body of ["two\nlines", "\u202Ehidden"]) {
      const snapshot = makeGitHubSnapshot({ pulls: [makeGitHubPull({ body })] });
      expect(GitHubSnapshot.safeParse(snapshot).success).toBe(false);
      const issues = makeGitHubSnapshot({ issues: [makeGitHubIssue({ body })] });
      expect(GitHubSnapshot.safeParse(issues).success).toBe(false);
    }
  });

  it("refuses a changed path that is over 4,096 code points or not one plain line", () => {
    expect(INFLIGHT_PATH_MAX_LENGTH).toBe(4096);
    const long = `src/${"a".repeat(INFLIGHT_PATH_MAX_LENGTH)}.py`;
    for (const path of ["a\u202Eb.py", "a\nb.py", "a\tb.py", "a\u0000b", "a/\u200Bb", long]) {
      expect(isInflightPath(path)).toBe(false);
      const snapshot = makeGitHubSnapshot({ pulls: [makeGitHubPull({ files: [path] })] });
      expect(GitHubSnapshot.safeParse(snapshot).success).toBe(false);
    }
    const ok = `src/${"a".repeat(INFLIGHT_PATH_MAX_LENGTH - 7)}.py`;
    expect([...ok]).toHaveLength(INFLIGHT_PATH_MAX_LENGTH);
    expect(isInflightPath(ok)).toBe(true);
    const snapshot = makeGitHubSnapshot({
      pulls: [makeGitHubPull({ files: [ok, "[[x]]/`y`.py"] })],
    });
    expect(GitHubSnapshot.safeParse(snapshot).success).toBe(true);
  });

  it("refuses a repository name of dots, an invalid owner, and a host other than github.com", () => {
    for (const repo of [
      { ...DEMO_REPO, name: ".." },
      { ...DEMO_REPO, owner: "acme/x" },
      { ...DEMO_REPO, host: "gitlab.com" },
    ]) {
      expect(GitHubSnapshot.safeParse(makeGitHubSnapshot({ repo } as never)).success).toBe(false);
    }
  });
});

describe("the inflight role and run kind (spec v2 #9 R20)", () => {
  it("adds inflight to LlmRole and RunKind, so its ledger rows and config parse", () => {
    expect(LlmRole.options).toContain("inflight");
    expect(RunKind.options).toEqual(["build", "update", "inflight"]);
    const row = makeLedgerEntry({ purpose: "inflight", runKind: "inflight", sha: SHA_A });
    expect(LedgerEntry.parse(row)).toEqual(row);
    expect(LlmConfigFile.parse({ models: { inflight: "claude-haiku-4-5" } })).toEqual({
      models: { inflight: "claude-haiku-4-5" },
    });
  });

  it("still parses every earlier row: build and update runs, and rows with no run kind", () => {
    for (const runKind of ["build", "update", undefined] as const) {
      const row = makeLedgerEntry(runKind === undefined ? {} : { runKind, sha: SHA_A });
      expect(LedgerEntry.parse(row)).toEqual(row);
    }
  });
});
