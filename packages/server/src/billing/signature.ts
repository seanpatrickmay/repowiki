import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a webhook's signed timestamp may be from now (billing spec B8): Stripe's default. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "malformed" | "mismatch" | "stale" };

const HEX_SHA256 = /^[0-9a-f]{64}$/;

const sign = (secret: string, timestamp: number, body: Buffer) =>
  createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();

/**
 * Checks a `Stripe-Signature` header against the raw request body (billing spec B8): an
 * HMAC-SHA256 of "<t>.<body>" under the endpoint's signing secret, compared in constant time
 * with each `v1` value, with `t` within five minutes of now either way.
 */
export function verifyStripeSignature(input: {
  header: string | undefined;
  rawBody: Buffer;
  secret: string;
  now: number;
}): SignatureCheck {
  let timestamp: number | null = null;
  const candidates: Buffer[] = [];
  for (const part of (input.header ?? "").split(",")) {
    const at = part.indexOf("=");
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "t") return { ok: false, reason: "malformed" };
    else if (key === "v1") {
      if (!HEX_SHA256.test(value)) return { ok: false, reason: "malformed" };
      candidates.push(Buffer.from(value, "hex"));
    }
  }
  if (timestamp === null || candidates.length === 0) return { ok: false, reason: "malformed" };
  const expected = sign(input.secret, timestamp, input.rawBody);
  // Every candidate is compared, so the time taken never says which one matched.
  let matched = false;
  for (const candidate of candidates) {
    if (timingSafeEqual(candidate, expected)) matched = true;
  }
  if (!matched) return { ok: false, reason: "mismatch" };
  if (Math.abs(Math.floor(input.now / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, timestamp };
}

/** A `Stripe-Signature` header for a body, as Stripe would send it: for tests and replays. */
export function signStripeEvent(rawBody: Buffer, secret: string, now: number): string {
  const timestamp = Math.floor(now / 1000);
  return `t=${timestamp},v1=${sign(secret, timestamp, rawBody).toString("hex")}`;
}
