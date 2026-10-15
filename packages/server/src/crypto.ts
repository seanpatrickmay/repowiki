import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

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

export interface Sealed {
  /** The AES-256-GCM ciphertext followed by its 16-byte tag. */
  ciphertext: Buffer;
  nonce: Buffer;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypt `plaintext` bound to `associated` (an account id), so a row moved elsewhere fails. */
export function seal(key: Buffer, plaintext: string, associated: string): Sealed {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(associated, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

/** The plaintext, or null when the key, the associated data or any byte is wrong. */
export function unseal(key: Buffer, sealed: Sealed, associated: string): string | null {
  if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length < TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(associated, "utf8"));
    decipher.setAuthTag(sealed.ciphertext.subarray(-TAG_BYTES));
    const body = sealed.ciphertext.subarray(0, -TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
