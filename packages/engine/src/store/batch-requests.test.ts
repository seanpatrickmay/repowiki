import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("batch request journal", () => {
  it("finds a recorded request by key, across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-batches-"));
    dirs.push(dir);
    const path = join(dir, "wiki.db");
    const store = openStore(path);
    store.recordBatchRequests("msgbatch_1", "2026-10-01T12:00:00Z", [
      { requestKey: "k0", customId: "req-0" },
      { requestKey: "k1", customId: "req-1" },
    ]);
    store.close();
    const reopened = openStore(path);
    expect(reopened.findBatchRequest("k1")).toEqual({
      batchId: "msgbatch_1",
      customId: "req-1",
      createdAt: "2026-10-01T12:00:00Z",
    });
    expect(reopened.findBatchRequest("k9")).toBeNull();
    reopened.close();
  });

  it("points a request sent again at its newest batch", () => {
    const store = openStore(":memory:");
    store.recordBatchRequests("msgbatch_1", "2026-10-01T12:00:00Z", [
      { requestKey: "k0", customId: "req-0" },
    ]);
    store.recordBatchRequests("msgbatch_2", "2026-10-01T13:00:00Z", [
      { requestKey: "k0", customId: "req-3" },
    ]);
    expect(store.findBatchRequest("k0")).toEqual({
      batchId: "msgbatch_2",
      customId: "req-3",
      createdAt: "2026-10-01T13:00:00Z",
    });
    store.close();
  });

  it("forgets the requests it is told to", () => {
    const store = openStore(":memory:");
    store.recordBatchRequests("msgbatch_1", "2026-10-01T12:00:00Z", [
      { requestKey: "k0", customId: "req-0" },
      { requestKey: "k1", customId: "req-1" },
    ]);
    store.forgetBatchRequests(["k0", "k9"]);
    expect(store.findBatchRequest("k0")).toBeNull();
    expect(store.findBatchRequest("k1")?.customId).toBe("req-1");
    store.close();
  });

  it("drops requests older than the results TTL when it records a batch", () => {
    const store = openStore(":memory:");
    store.recordBatchRequests("msgbatch_1", "2026-09-01T12:00:00Z", [
      { requestKey: "old", customId: "req-0" },
    ]);
    store.recordBatchRequests("msgbatch_2", "2026-09-20T12:00:00Z", [
      { requestKey: "recent", customId: "req-0" },
    ]);
    store.recordBatchRequests("msgbatch_3", "2026-10-01T12:00:00Z", [
      { requestKey: "new", customId: "req-0" },
    ]);
    expect(store.findBatchRequest("old")).toBeNull();
    expect(store.findBatchRequest("recent")?.batchId).toBe("msgbatch_2");
    expect(store.findBatchRequest("new")?.batchId).toBe("msgbatch_3");
    store.close();
  });

  it.each([
    ["an empty batch id", "", "2026-10-01T12:00:00Z"],
    ["a created_at that is not a timestamp", "msgbatch_1", "yesterday"],
  ])("treats a row with %s as a miss", (_name, batchId, createdAt) => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-batches-"));
    dirs.push(dir);
    const path = join(dir, "wiki.db");
    openStore(path).close();
    const db = new Database(path);
    db.prepare(
      "INSERT INTO batch_requests (request_key, batch_id, custom_id, created_at) VALUES (?, ?, ?, ?)",
    ).run("k0", batchId, "req-0", createdAt);
    db.close();
    const store = openStore(path);
    expect(store.findBatchRequest("k0")).toBeNull();
    store.close();
  });
});
