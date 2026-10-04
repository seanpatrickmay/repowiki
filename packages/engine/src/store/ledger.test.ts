import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLedgerEntry } from "@repowiki/core/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("token ledger", () => {
  it("returns entries in append order, across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-ledger-"));
    dirs.push(dir);
    const path = join(dir, "wiki.db");
    const first = makeLedgerEntry();
    const second = makeLedgerEntry({ purpose: "write", featureId: "signals", batch: true });
    const store = openStore(path);
    store.appendLedger(first);
    store.appendLedger(second);
    store.close();
    const reopened = openStore(path);
    expect(reopened.listLedger()).toEqual([first, second]);
    reopened.close();
  });

  it("filters by run", () => {
    const store = openStore(":memory:");
    const mine = makeLedgerEntry({ runId: "run-b" });
    store.appendLedger(makeLedgerEntry({ runId: "run-a" }));
    store.appendLedger(mine);
    expect(store.listLedger("run-b")).toEqual([mine]);
    expect(store.listLedger("run-c")).toEqual([]);
    store.close();
  });

  it("validates entries before storing them", () => {
    const store = openStore(":memory:");
    const bad = makeLedgerEntry({ tokens: { in: -1, out: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(() => store.appendLedger(bad)).toThrow();
    expect(store.listLedger()).toEqual([]);
    store.close();
  });
});
