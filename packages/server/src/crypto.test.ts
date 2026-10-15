import { describe, expect, it } from "vitest";
import { randomToken, safeEqual, seal, sha256Hex, unseal } from "./crypto.ts";

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

describe("sealed GitHub tokens (spec 2 S7)", () => {
  const key = Buffer.alloc(32, 9);
  const other = Buffer.alloc(32, 8);

  it("round-trip under the same key and account", () => {
    const sealed = seal(key, "gho_secret", "account-1");
    expect(sealed.ciphertext.toString("utf8")).not.toContain("gho_secret");
    expect(sealed.nonce).toHaveLength(12);
    expect(unseal(key, sealed, "account-1")).toBe("gho_secret");
  });

  it("fail closed with another key, another account, a flipped bit or a short body", () => {
    const sealed = seal(key, "gho_secret", "account-1");
    expect(unseal(other, sealed, "account-1")).toBeNull();
    expect(unseal(key, sealed, "account-2")).toBeNull();
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(unseal(key, { ...sealed, ciphertext: flipped }, "account-1")).toBeNull();
    const tag = Buffer.from(sealed.ciphertext);
    tag[tag.length - 1] = (tag[tag.length - 1] ?? 0) ^ 1;
    expect(unseal(key, { ...sealed, ciphertext: tag }, "account-1")).toBeNull();
    expect(unseal(key, { ...sealed, ciphertext: Buffer.alloc(8) }, "account-1")).toBeNull();
    expect(unseal(key, { ...sealed, nonce: Buffer.alloc(0) }, "account-1")).toBeNull();
  });

  it("use a fresh nonce every time", () => {
    expect(seal(key, "x", "a").nonce.equals(seal(key, "x", "a").nonce)).toBe(false);
  });
});
