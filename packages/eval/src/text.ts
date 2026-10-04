import { CONTROL_CHARACTERS, INVISIBLE_CHARACTERS } from "@repowiki/core";

/**
 * Repository or wiki text as a tool result: CRLF becomes LF, and every control character other
 * than a newline or a tab (bidi controls included) becomes U+FFFD, one for one, so a file cannot
 * hide text from a reader of the transcript or forge structure in it.
 */
export function toolText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(CONTROL_CHARACTERS, (c) => (c === "\n" || c === "\t" ? c : "\uFFFD"));
}

/** Text that must stay on one line (a path, a title, a commit subject): newlines become spaces. */
export function oneLine(text: string): string {
  return toolText(text).replace(/\s+/g, " ").trim();
}

/** `text` cut to `max` code points with "…", for summaries and table cells. */
export function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Untrusted text as plain markdown text on one line, for a file the owner reads in a markdown
 * viewer (report.md, the accuracy sheet): `oneLine`, every invisible format character dropped
 * (core's INVISIBLE_CHARACTERS: zero-width, tag characters, soft hyphens), cut to `max` code
 * points, then every character that opens markdown or HTML syntax (a link, an image, an autolink,
 * a tag, a code span, emphasis, strikethrough, a heading, a table cell) escaped with a backslash.
 */
export function markdownText(text: string, max: number): string {
  const plain = oneLine(text).replace(INVISIBLE_CHARACTERS, "").replace(/ {2,}/g, " ").trim();
  return cut(plain, max).replace(/[\\`*_[\]()<>!#|~]/g, (c) => `\\${c}`);
}

/** "1 file", "2 files". */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
