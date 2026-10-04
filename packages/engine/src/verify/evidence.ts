import type { Citation } from "@repowiki/core";

/**
 * A TODO, FIXME, XXX or HACK marker as a whole word after a comment opener (`#`, `//`, `/*`,
 * `<!--`, `--`, or a block comment's leading `*`) on the same line. A name like `Status.TODO` or a
 * string like `"TODO"` is not a marker.
 */
export const TODO_MARKER = /(?:^[ \t]*\*|#|\/\/|\/\*|<!--|--)[^\n]*\b(?:TODO|FIXME|XXX|HACK)\b/m;

/** The start of a line that is only a comment, so a skip mentioned in it is not a skip. */
const COMMENT_LINE = "[ \\t]*(?:#|//|/\\*|\\*|<!--|--)";
/** Not preceded by an identifier character, `$` or `.`: `obj.xit(` and `$xit(` are other things. */
const BARE = "(?<![\\w$.])";
const SKIPS = [
  // pytest: decorators, a module-level `pytestmark = ...`, and imperative skips
  "pytest\\.mark\\.(?:skip|skipif|xfail)\\b",
  "\\bpytest\\.skip\\(",
  // unittest
  "@unittest\\.skip",
  "\\bself\\.skipTest\\(",
  // Vitest, Jest and Mocha
  `${BARE}(?:it|test|describe)\\.(?:skip(?:\\.each)?|todo|skipIf)\\(`,
  `${BARE}(?:xit|xtest|xdescribe)\\(`,
];
/** A skipped, expected-to-fail or to-do test in pytest, unittest, Vitest, Jest or Mocha. */
export const SKIPPED_TEST = new RegExp(`^(?!${COMMENT_LINE})[^\\n]*?(?:${SKIPS.join("|")})`, "m");

/** A commit that undoes another: git's `Revert "…"`, or a Conventional Commits `revert:`. */
export const REVERT_SUBJECT = /^revert\b/i;

/**
 * Whether a resolved citation is evidence for a known limitation (spec §5 rule 3): cited lines
 * that hold a TODO/FIXME or a skipped test, or a reverting commit. `lines` is the cited text.
 */
export function isLimitationEvidence(citation: Citation, lines: string | null): boolean {
  if (citation.kind === "commit") return REVERT_SUBJECT.test(citation.subject);
  return lines !== null && (TODO_MARKER.test(lines) || SKIPPED_TEST.test(lines));
}
