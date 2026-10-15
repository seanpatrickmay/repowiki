import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url: session ids, CSRF tokens, job tokens. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Constant-time equality for secrets of any length. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(sha256Hex(a), "hex");
  const y = Buffer.from(sha256Hex(b), "hex");
  return timingSafeEqual(x, y) && a.length === b.length;
}
