import type { Citation } from "@repowiki/core";

/** A TODO or FIXME comment marker. */
export const TODO_MARKER = /\b(?:TODO|FIXME)\b/;
/** A skipped, expected-to-fail or to-do test in pytest, unittest, Vitest, Jest or Mocha. */
export const SKIPPED_TEST =
  /@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.skip|\bpytest\.skip\(|\b(?:it|test|describe)\.(?:skip|todo)\(|\b(?:xit|xtest|xdescribe)\(/;
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
