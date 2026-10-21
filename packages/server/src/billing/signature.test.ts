import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signStripeEvent, verifyStripeSignature } from "./signature.ts";

const SECRET = "whsec_testsecret";
const BODY = Buffer.from('{"id":"evt_1","type":"invoice.paid"}');
const NOW = Date.parse("2026-10-21T12:00:00Z");
const T = Math.floor(NOW / 1000);
const v1 = (t: number, body: Buffer, secret = SECRET) =>
  createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex");
const verify = (header: string | undefined, body = BODY, now = NOW) =>
  verifyStripeSignature({ header, rawBody: body, secret: SECRET, now });

describe("verifyStripeSignature (billing spec B8)", () => {
  it("accepts Stripe's scheme: HMAC-SHA256 of '<t>.<body>' under the signing secret", () => {
    expect(verify(`t=${T},v1=${v1(T, BODY)}`)).toEqual({ ok: true, timestamp: T });
  });

  it("accepts any one matching v1 among several, ignoring v0 and unknown parts", () => {
    const header = `t=${T},v1=${"0".repeat(64)},v0=abc,v1=${v1(T, BODY)},x=1`;
    expect(verify(header)).toEqual({ ok: true, timestamp: T });
  });

  it("refuses the wrong secret, a changed body and a changed timestamp", () => {
    expect(verify(`t=${T},v1=${v1(T, BODY, "whsec_other")}`)).toMatchObject({ ok: false });
    expect(verify(`t=${T},v1=${v1(T, BODY)}`, Buffer.from('{"id":"evt_2"}'))).toMatchObject({
      ok: false,
    });
    expect(verify(`t=${T + 1},v1=${v1(T, BODY)}`)).toMatchObject({ ok: false });
  });

  it("refuses a timestamp more than five minutes old or ahead", () => {
    const old = T - 301;
    expect(verify(`t=${old},v1=${v1(old, BODY)}`)).toMatchObject({ ok: false, reason: "stale" });
    const ahead = T + 301;
    expect(verify(`t=${ahead},v1=${v1(ahead, BODY)}`)).toMatchObject({
      ok: false,
      reason: "stale",
    });
    const edge = T - 300;
    expect(verify(`t=${edge},v1=${v1(edge, BODY)}`)).toMatchObject({ ok: true });
  });

  it("refuses a missing or malformed header", () => {
    for (const header of [
      undefined,
      "",
      "v1=abc",
      `t=${T}`,
      `t=x,v1=${v1(T, BODY)}`,
      `t=${T},v1=zz`,
    ]) {
      expect(verify(header)).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("signs an event the way it verifies, for tests and local replays", () => {
    expect(verify(signStripeEvent(BODY, SECRET, NOW))).toEqual({ ok: true, timestamp: T });
  });
});
