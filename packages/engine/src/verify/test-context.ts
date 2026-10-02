import { INGEST_PY, SHA_A } from "@repowiki/core/test-fixtures";
import type { CommitInfo } from "../index/index.ts";
import type { VerifyContext } from "./claims.ts";

export const TEST_PY = [
  "import pytest",
  "",
  "",
  '@pytest.mark.skip(reason="flaky upstream")',
  "def test_long_chunk():",
  "    assert True",
  "",
].join("\n");

const commit = (sha: string, subject: string, pr: number | null = null): CommitInfo => ({
  sha,
  parents: [],
  date: "2026-02-03T10:00:00-05:00",
  subject,
  files: ["src/signals/ingest.py"],
  pr,
});

export const COMMITS: CommitInfo[] = [
  commit(`abcdef1${"0".repeat(33)}`, "feat: add signal ingestion", 45),
  commit(`abcdef2${"0".repeat(33)}`, 'Revert "feat: page through chunks"'),
  commit(`1234567${"0".repeat(33)}`, "fix: skip blank sentences"),
  commit(`1234567${"1".repeat(33)}`, "chore: bump"),
];

/** Files and commits at SHA_A: the fixture's ingest.py (TODO on line 20) and a skipped test. */
export function testContext(): VerifyContext {
  return {
    sha: SHA_A,
    sources: new Map([
      ["src/signals/ingest.py", INGEST_PY],
      ["tests/test_ingest.py", TEST_PY],
    ]),
    symbolsOf: (path) =>
      path === "src/signals/ingest.py"
        ? [
            { qualifiedName: "ingest_chunk", startLine: 10, endLine: 24 },
            { qualifiedName: "Signal", startLine: 27, endLine: 30 },
          ]
        : [],
    commits: COMMITS,
  };
}
