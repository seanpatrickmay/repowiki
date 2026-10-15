import { describe, expect, it } from "vitest";
import { randomToken, safeEqual, sha256Hex } from "./crypto.ts";

describe("crypto helpers (spec 2 S6)", () => {
  it("makes 32-byte url-safe tokens that differ", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  it("hashes with SHA-256 and compares in constant time", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("same", "diff")).toBe(false);
    expect(safeEqual("short", "longer")).toBe(false);
  });
});
