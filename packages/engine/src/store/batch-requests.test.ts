import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
