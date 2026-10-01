import { createHash } from "node:crypto";

/**
 * SHA-256 of cited source lines. Line endings are normalized to "\n" and one trailing newline
 * is ignored, so CRLF and LF checkouts of the same code hash identically.
 */
export function contentHash(lines: string): string {
  const normalized = lines.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
