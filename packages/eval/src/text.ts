import { CONTROL_CHARACTERS } from "@repowiki/core";

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

/** "1 file", "2 files". */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
