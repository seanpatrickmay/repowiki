import { INFLIGHT_FILLERS, INVISIBLE_CHARACTERS } from "./alias.ts";

/** Every whitespace character: JavaScript's `\s` (which holds U+2028 and U+2029) and NEL. */
const WHITESPACE = /[\s\u0085]+/gu;

/**
 * Text as People compares and checks it (spec v2 #6 §12, the fix-forward ruling): well formed (a
 * lone surrogate becomes U+FFFD), NFKC, every whitespace character (U+2028, U+2029 and NEL
 * included) one space, every other control, bidi, invisible or filler character dropped (M10's
 * INFLIGHT_FILLERS), spaces collapsed and trimmed. One normaliser for the email check, name
 * keys and the visible-content check.
 */
export function normalizedText(text: string): string {
  return text
    .toWellFormed()
    .normalize("NFKC")
    .replace(WHITESPACE, " ")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(INFLIGHT_FILLERS, "")
    .replace(/ +/g, " ")
    .trim();
}

/** What is left of normalized text that renders as nothing: joiners, combining marks, spaces. */
const UNSEEN = /[\s\p{M}]|\u200C|\u200D/gu;

/** Whether `text` holds a character a reader sees (R14: else a name is "Contributor <n>"). */
export function hasVisibleText(text: string): boolean {
  return normalizedText(text).replace(UNSEEN, "") !== "";
}

/** RFC 5322 local-part punctuation (`atext` and the dot), minus `/`, which paths hold. */
const LOCAL_PUNCT = "!#$%&'*+=?^`{|}~.\\-";
/** Where a local part's core starts: a letter, a digit, a mark (in any script) or `_`. */
const LOCAL_START = "\\p{L}\\p{N}\\p{M}_";
const LOCAL = `[${LOCAL_START}${LOCAL_PUNCT}]`;
/** A domain: labels of letters, digits, marks and hyphens, then a TLD of two or more letters. */
const DOMAIN = "(?:[\\p{L}\\p{N}\\p{M}\\-]+\\.)+\\p{L}[\\p{L}\\p{M}]+";

/**
 * What an email address looks like in free text: a quoted local part, or a dot-atom one that
 * starts where a run of local-part characters starts (so the scan is linear: a match can only
 * begin at a run's start), its leading punctuation kept outside the match (group 1) unless it is
 * all punctuation, and GitHub's `[bot]` suffix; an optional comment; `@`; a domain.
 */
const EMAIL_TOKEN = new RegExp(
  `(?:"[^"\\r\\n]{1,64}"|(?<!${LOCAL})(?:([${LOCAL_PUNCT}]*)[${LOCAL_START}]${LOCAL}*|[${LOCAL_PUNCT}]+)(?:\\[bot\\])?)` +
    `(?:\\([^()\\r\\n]{0,64}\\))?@${DOMAIN}`,
  "gu",
);
const EMAIL_TEST = new RegExp(EMAIL_TOKEN.source, "u");

const replaced = (text: string): string =>
  text.replace(EMAIL_TOKEN, (_match, lead: string | undefined) => `${lead ?? ""}[email]`);

/** Line separators other than ASCII whitespace can sit inside an address: the check drops them. */
const SEPARATORS = /[\u0085\u2028\u2029]/g;

/** The copy the email check reads: normalized, with U+3002 (the ideographic full stop) a dot. */
const checkedCopy = (text: string): string =>
  normalizedText(text.replace(SEPARATORS, "")).replace(/\u3002/g, ".");

/**
 * Text with every email-shaped token replaced by "[email]" (planner ruling R5, the fix-forward
 * ruling): People never shows an address, even one a commit subject or a pull-request title
 * quotes. It replaces on the raw text, then checks a normalized copy, which catches fullwidth and
 * small `@` and dots and an address split by an invisible character or NEL; when the copy still
 * holds one, the copy is returned with its addresses replaced. Text with no address comes back
 * unchanged. Linear in the text's length.
 */
export function withoutEmails(text: string): string {
  const scrubbed = replaced(text);
  const copy = checkedCopy(scrubbed);
  return EMAIL_TEST.test(copy) ? replaced(copy) : scrubbed;
}

/** Whether `text` holds an email-shaped token, raw or in its normalized copy. */
export function holdsEmail(text: string): boolean {
  return withoutEmails(text) !== text;
}
