import { describe, expect, it } from "vitest";
import {
  GitHubSnapshot,
  githubBlobUrl,
  githubUrl,
  inflightBody,
  inflightLine,
} from "./inflight.ts";
import { LedgerEntry, LlmConfigFile, LlmRole, RunKind } from "./llm.ts";
import {
  DEMO_REPO,
  makeGitHubIssue,
  makeGitHubPull,
  makeGitHubSnapshot,
  makeLedgerEntry,
  SHA_A,
  SHA_C,
} from "./test-fixtures.ts";

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

  it("links a file's lines at a commit with percent-encoded path segments", () => {
    expect(githubBlobUrl(DEMO_REPO, SHA_C, "src/a b/#x?.py", 3, 9)).toBe(
      `https://github.com/acme/demo/blob/${SHA_C}/src/a%20b/%23x%3F.py#L3-L9`,
    );
    expect(githubBlobUrl(DEMO_REPO, SHA_C, "a.py", 4, 4)).toBe(
      `https://github.com/acme/demo/blob/${SHA_C}/a.py#L4`,
    );
  });
});

describe("GitHubSnapshot", () => {
  it("accepts the fixture snapshot", () => {
    expect(GitHubSnapshot.parse(makeGitHubSnapshot())).toEqual(makeGitHubSnapshot());
  });

  it("refuses a body that still holds a newline or a bidi control", () => {
    for (const body of ["two\nlines", "\u202Ehidden"]) {
      const snapshot = makeGitHubSnapshot({ pulls: [makeGitHubPull({ body })] });
      expect(GitHubSnapshot.safeParse(snapshot).success).toBe(false);
      const issues = makeGitHubSnapshot({ issues: [makeGitHubIssue({ body })] });
      expect(GitHubSnapshot.safeParse(issues).success).toBe(false);
    }
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
