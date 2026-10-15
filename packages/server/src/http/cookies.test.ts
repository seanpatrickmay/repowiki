import { describe, expect, it } from "vitest";
import { parseCookies, serializeCookie, sessionCookieName } from "./cookies.ts";

describe("cookies (spec 2 S6)", () => {
  it("parse a Cookie header, first value winning", () => {
    expect(parseCookies("a=1; b=two%20words; a=3; bad")).toEqual(
      new Map([
        ["a", "1"],
        ["b", "two words"],
      ]),
    );
    expect(parseCookies(undefined)).toEqual(new Map());
  });

  it("serialize a secure session cookie and a loopback one", () => {
    expect(
      serializeCookie("__Host-session", "tok", { maxAgeSeconds: 60, secure: true, httpOnly: true }),
    ).toBe("__Host-session=tok; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure");
    expect(
      serializeCookie("session", "", { maxAgeSeconds: 0, secure: false, httpOnly: true }),
    ).toBe("session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly");
    expect(sessionCookieName(true)).toBe("__Host-session");
    expect(sessionCookieName(false)).toBe("session");
  });
});
