import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import { appendAudit } from "./audit.ts";
import { freshDb } from "./test-db.ts";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(async () => db.close());

describe("appendAudit (spec 2 S5)", () => {
  it("appends a valid event and refuses an invalid one", async () => {
    const event = {
      id: "00000000-0000-4000-8000-0000000000e1",
      actor: "system",
      action: "account.create",
      target: { entity: "account", id: "00000000-0000-4000-8000-000000000001" },
      outcome: "allowed",
      createdAt: "2026-10-14T12:00:00.000Z",
    } as const;
    await appendAudit(db, event);
    const rows = await db.query<{ body: unknown }>("SELECT body FROM audit_events");
    expect(rows.map((r) => r.body)).toEqual([event]);
    await expect(appendAudit(db, { ...event, action: "Bad Action" })).rejects.toThrow("invalid");
  });
});
