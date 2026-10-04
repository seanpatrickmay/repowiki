/** Aliases go into page headings, link lookups and every write call's prompt, so they stay short. */
export const ALIAS_MAX_LENGTH = 60;

/**
 * C0 and C1 controls (newline, tab and DEL included: Cc), U+2028 / U+2029 (Zl, Zp), and the invisible
 * characters that reorder or hide text: bidi embeddings and overrides U+202A-U+202E, bidi isolates
 * U+2066-U+2069, and the byte order mark U+FEFF. Not all of Cf: ZWJ (U+200D) and ZWNJ (U+200C)
 * are needed by emoji sequences and by Persian, Indic and Arabic scripts, so they pass through.
 */
export const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/** The distinct control or invisible characters in `text`, in order of appearance, as "U+XXXX". */
export function controlCharacters(text: string): string[] {
  const found = (text.match(CONTROL_CHARACTERS) ?? []).map(
    (c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
  );
  return [...new Set(found)];
}

/**
 * Why `alias` cannot be a feature alias, or null when it can: blank, longer than ALIAS_MAX_LENGTH
 * code points, or holding a control or invisible character. The one source of the rule: the manifest
 * step checks model aliases with it, the linker checks code identifiers, and the store refuses
 * additions that fail it. Callers skip a failing alias; none shortens it.
 */
export function aliasProblem(alias: string): string | null {
  if (alias.trim() === "") return "is empty";
  const length = [...alias].length;
  if (length > ALIAS_MAX_LENGTH) {
    return `is ${length} characters; use at most ${ALIAS_MAX_LENGTH}`;
  }
  const controls = controlCharacters(alias);
  if (controls.length > 0) return `has a control or invisible character (${controls.join(", ")})`;
  return null;
}
