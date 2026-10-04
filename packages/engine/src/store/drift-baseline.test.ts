import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeManifest, SHA_A, SHA_B, SHA_C } from "@repowiki/core/test-fixtures";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, runMigrations } from "./migrations.ts";
import { openStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A store at schema 7 holding manifests at `shas`, in order, each with llm_revised as given. */
function storeAtSchema7(rows: [string, 0 | 1][]): string {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-baseline-"));
  dirs.push(dir);
  const path = join(dir, "wiki.db");
  const db = new Database(path);
  runMigrations(db, MIGRATIONS.slice(0, 7));
  rows.forEach(([sha, revised], i) => {
    db.prepare("INSERT INTO manifests (sha, seq, body, llm_revised) VALUES (?, ?, ?, ?)").run(
      sha,
      i + 1,
      JSON.stringify(makeManifest({ sha })),
      revised,
    );
  });
  db.close();
  return path;
}

describe("migration 8: a drift baseline for every store with a manifest", () => {
  it("makes the first manifest the baseline of a store that has none (spec §6.1)", () => {
    const store = openStore(
      storeAtSchema7([
        [SHA_A, 0],
        [SHA_B, 0],
      ]),
    );
    expect(store.getDriftBaseline()?.sha).toBe(SHA_A);
    expect(store.getLatestManifest()?.sha).toBe(SHA_B);
    store.close();
  });

  it("leaves a store that already has a baseline as it is", () => {
    const store = openStore(
      storeAtSchema7([
        [SHA_A, 0],
        [SHA_B, 1],
        [SHA_C, 0],
      ]),
    );
    expect(store.getDriftBaseline()?.sha).toBe(SHA_B);
    store.close();
  });

  it("does nothing to a store with no manifest", () => {
    const store = openStore(storeAtSchema7([]));
    expect(store.getDriftBaseline()).toBeNull();
    store.close();
  });
});
