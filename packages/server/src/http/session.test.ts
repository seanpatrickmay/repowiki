import type { Account } from "@repowiki/hosted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import type { Db } from "../db/db.ts";
import { signIn } from "../store/accounts.ts";
import { createSession } from "../store/sessions.ts";
import { freshDb } from "../store/test-db.ts";
import { HttpError } from "./body.ts";
import { checkMutation, currentSession, type Session, sessionSetCookie } from "./session.ts";

const T0 = "2026-10-14T12:00:00.000Z";
const A1 = "00000000-0000-4000-8000-000000000001";
const dev = loadConfig({ REPOWIKI_MODE: "demo" });
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  await signIn(
    db,
    { githubUserId: 1, login: "u1", displayName: "U", githubCreatedAt: "2019-01-01T00:00:00Z" },
    { newAccountId: A1, allowNew: () => true, now: T0 },
  );
});
afterEach(async () => db.close());

describe("currentSession (spec 2 S6)", () => {
  it("reads the session cookie for this origin's cookie name", async () => {
    const { token, csrf } = await createSession(db, A1, T0);
    const session = await currentSession(
      db,
      dev,
      { headers: { cookie: `other=1; session=${token}` }, raw: {} },
      T0,
    );
    expect(session).toMatchObject({ account: { id: A1 }, csrf, token });
    expect(
      await currentSession(
        db,
        dev,
        { headers: { cookie: `__Host-session=${token}` }, raw: {} },
        T0,
      ),
    ).toBeNull();
    expect(
      await currentSession(db, dev, { headers: { cookie: "session=unknown" }, raw: {} }, T0),
    ).toBeNull();
    expect(await currentSession(db, dev, { headers: {}, raw: {} }, T0)).toBeNull();
  });

  it("sets a Secure __Host- cookie only on an https origin", () => {
    expect(sessionSetCookie(dev, "t", 60)).toBe(
      "session=t; Path=/; Max-Age=60; SameSite=Lax; HttpOnly",
    );
    const prod = { ...dev, origin: "https://repowiki.dev" };
    expect(sessionSetCookie(prod, "t", 60)).toBe(
      "__Host-session=t; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure",
    );
  });
});

describe("checkMutation (spec 2 S6)", () => {
  const session: Session = { account: {} as never, csrf: "right", token: "t" };
  const origin = dev.origin;

  it("passes our origin with the session's CSRF token", () => {
    expect(() => checkMutation(dev, { origin }, session, "right")).not.toThrow();
  });

  it("refuses a foreign, missing or repeated Origin, a wrong token, or no session", () => {
    const refuse = (f: () => void) => {
      let caught: unknown;
      try {
        f();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(403);
    };
    refuse(() => checkMutation(dev, { origin: "https://evil.example" }, session, "right"));
    refuse(() => checkMutation(dev, { origin: `${origin}.evil.example` }, session, "right"));
    refuse(() => checkMutation(dev, { origin: "null" }, session, "right"));
    refuse(() => checkMutation(dev, {}, session, "right"));
    refuse(() => checkMutation(dev, { origin: [origin, origin] }, session, "right"));
    refuse(() => checkMutation(dev, { origin }, session, "wrong"));
    refuse(() => checkMutation(dev, { origin }, session, ""));
    refuse(() => checkMutation(dev, { origin }, session, null));
    refuse(() => checkMutation(dev, { origin }, null, "right"));
  });
});

describe("the mutation limit (spec 2 §10, M14e A3)", () => {
  it("allows 60 mutations a minute per session and answers the 61st 429", () => {
    const config = loadConfig({ REPOWIKI_MODE: "demo" });
    const headers = { origin: config.origin };
    const session = {
      account: {} as Account,
      csrf: "c".repeat(43),
      token: `limit-${Math.random()}`,
    };
    for (let i = 0; i < 60; i++) checkMutation(config, headers, session, session.csrf);
    expect(() => checkMutation(config, headers, session, session.csrf)).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    const other = { ...session, token: `limit-${Math.random()}` };
    expect(() => checkMutation(config, headers, other, other.csrf)).not.toThrow();
  });
});
