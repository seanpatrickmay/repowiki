import { describe, expect, it } from "vitest";
import { isLimitationEvidence, REVERT_SUBJECT, SKIPPED_TEST, TODO_MARKER } from "./evidence.ts";

describe("TODO_MARKER", () => {
  it.each([
    "# TODO: handle blank sentences",
    "x = 1  # FIXME later",
    "// FIXME: leaks",
    "int x; // XXX revisit",
    "/* HACK for upstream */",
    " * TODO page through chunks",
    "<!-- TODO: link -->",
    "SELECT 1; -- TODO index",
    "line one\n# TODO: on the second line",
  ])("matches a marker in a comment: %j", (line) => {
    expect(TODO_MARKER.test(line)).toBe(true);
  });

  it.each([
    "Status.TODO",
    'status = "TODO"',
    "@TODO",
    "# TODOS are tracked elsewhere",
    "# TODO_LIST is a constant",
    "# a MYTODO",
    "const marker = /\\b(?:TODO|FIXME)\\b/;",
    "a * TODO",
    "TODO: not in a comment",
    "# note\nTODO on a later, uncommented line",
  ])("ignores a marker outside a comment or inside a longer word: %j", (line) => {
    expect(TODO_MARKER.test(line)).toBe(false);
  });
});

describe("SKIPPED_TEST", () => {
  it.each([
    '@pytest.mark.skip(reason="flaky")',
    '@pytest.mark.skipif(sys.platform == "win32", reason="posix")',
    "@pytest.mark.xfail",
    "pytestmark = pytest.mark.skip",
    'pytestmark = pytest.mark.skipif(True, reason="x")',
    "pytestmark = pytest.mark.xfail",
    'pytest.skip("no network")',
    "@unittest.skip('x')",
    "@unittest.skipIf(True, 'x')",
    "@unittest.skipUnless(False, 'x')",
    "        self.skipTest('no network')",
    "it.skip('works', () => {})",
    "test.skip('works', () => {})",
    "describe.skip('suite', () => {})",
    "it.todo('later')",
    "test.todo('later')",
    "describe.todo('later')",
    "it.skip.each([1, 2])('case %i', () => {})",
    "test.skip.each([1, 2])('case %i', () => {})",
    "describe.skip.each([1, 2])('case %i', () => {})",
    "test.skipIf(isCI)('works', () => {})",
    "it.skipIf(isCI)('works', () => {})",
    "describe.skipIf(isCI)('suite', () => {})",
    "xit('works', () => {})",
    "xtest('works', () => {})",
    "xdescribe('suite', () => {})",
    "  await xit('works', () => {})",
    "import pytest\n\n@pytest.mark.skip\ndef test_x(): ...",
  ])("matches a skipped test: %j", (line) => {
    expect(SKIPPED_TEST.test(line)).toBe(true);
  });

  it.each([
    "// it.skip('works', () => {})",
    "# @pytest.mark.skipif would go here",
    "    # self.skipTest('x')",
    " * test.skip('x')",
    "/* xit('x') */",
    "<!-- it.todo('x') -->",
    "-- test.skip('x')",
    "$xit('works')",
    "obj.xit('works')",
    "obj.test.skip('works')",
    "$it.skip('works')",
    "mytest.skip('works')",
    "it.skipped('works')",
    "def test_ordinary(): ...",
    "it('works', () => {})",
    "pytest.mark.parametrize('x', [1])",
  ])("ignores a comment or a lookalike: %j", (line) => {
    expect(SKIPPED_TEST.test(line)).toBe(false);
  });
});

describe("REVERT_SUBJECT", () => {
  it("matches git's Revert and a revert: prefix, not a later mention", () => {
    expect(REVERT_SUBJECT.test('Revert "feat: x"')).toBe(true);
    expect(REVERT_SUBJECT.test("revert: feat x")).toBe(true);
    expect(REVERT_SUBJECT.test("fix: Revert x")).toBe(false);
  });
});

describe("isLimitationEvidence", () => {
  const code = {
    kind: "code",
    path: "a.py",
    startLine: 1,
    endLine: 1,
    sha: "a".repeat(40),
    symbol: null,
    contentHash: "0".repeat(64),
  } as const;

  it("reads cited lines for code and the subject for a commit", () => {
    expect(isLimitationEvidence(code, "# TODO: x")).toBe(true);
    expect(isLimitationEvidence(code, "x = 1")).toBe(false);
    expect(isLimitationEvidence(code, null)).toBe(false);
    const commit = {
      kind: "commit",
      sha: "b".repeat(40),
      subject: 'Revert "x"',
      pr: null,
    } as const;
    expect(isLimitationEvidence(commit, null)).toBe(true);
  });
});
