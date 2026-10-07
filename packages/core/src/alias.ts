import { FEATURE_ID_MAX_LENGTH } from "./feature.ts";

/** Aliases go into page headings, link lookups and every write call's prompt, so they stay short. */
export const ALIAS_MAX_LENGTH = 60;

/**
 * The one rule for characters that can forge or hide structure in a prompt, a page or a URL: C0
 * and C1 controls (newline, tab and DEL included: Cc), U+2028 / U+2029 (Zl, Zp), every
 * bidirectional control (Bidi_C: the marks ALM U+061C, LRM U+200E and RLM U+200F, embeddings and
 * overrides U+202A-U+202E, isolates U+2066-U+2069), and the byte order mark U+FEFF. Global, for
 * replace and match; derive a non-global copy for test.
 *
 * Not all of Cf: ZWJ (U+200D) and ZWNJ (U+200C) are needed by emoji sequences and by Persian,
 * Indic and Arabic scripts, so they pass through. INVISIBLE_CHARACTERS adds the rest of Cf.
 */
export const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_C}\uFEFF]/gu;

/**
 * CONTROL_CHARACTERS plus every other invisible format character (Cf: tag characters, word
 * joiners, invisible operators, zero-width spaces, soft hyphens), still minus ZWJ and ZWNJ: for
 * text a reader is handed whole, such as a Wikipedia preview. Global, like CONTROL_CHARACTERS.
 */
export const INVISIBLE_CHARACTERS = new RegExp(
  `(?![\\u200C\\u200D])(?:${CONTROL_CHARACTERS.source}|\\p{Cf})`,
  "gu",
);

/**
 * Characters INVISIBLE_CHARACTERS (the shared rule) lets through that still render as nothing: the
 * combining grapheme joiner, the Hangul fillers, the braille blank, variation selectors and the
 * object replacement character. inflightLine and inflightBody blank them too (R13), and People's
 * normalizedText drops them. Global, like INVISIBLE_CHARACTERS.
 */
export const INFLIGHT_FILLERS = /\u034F|[\u115F\u1160\u2800\u3164\uFFA0\uFFFC]|[\uFE00-\uFE0F]/g;

/**
 * The URL slug the reader site gives an alias: accents stripped, ASCII lowercase kebab-case, at
 * most FEATURE_ID_MAX_LENGTH characters. Two names with one slug are one route, so the linker
 * compares code aliases in this form too.
 */
export function aliasSlug(alias: string): string {
  return alias
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FEATURE_ID_MAX_LENGTH)
    .replace(/-+$/, "");
}

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
