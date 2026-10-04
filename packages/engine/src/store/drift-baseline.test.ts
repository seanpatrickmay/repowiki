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

  /** A store at `version` (3 to 7) holding manifests at `shas`; from 4 on, with llm_revised. */
  function storeAt(version: number, rows: [string, 0 | 1][]): string {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-baseline-"));
    dirs.push(dir);
    const path = join(dir, "wiki.db");
    const db = new Database(path);
    runMigrations(db, MIGRATIONS.slice(0, version));
    rows.forEach(([sha, revised], i) => {
      const body = JSON.stringify(makeManifest({ sha }));
      if (version < 4) {
        db.prepare("INSERT INTO manifests (sha, seq, body) VALUES (?, ?, ?)").run(sha, i + 1, body);
      } else {
        db.prepare("INSERT INTO manifests (sha, seq, body, llm_revised) VALUES (?, ?, ?, ?)").run(
          sha,
          i + 1,
          body,
          revised,
        );
      }
    });
    db.close();
    return path;
  }
  const versionOf = (path: string): number => {
    const db = new Database(path, { readonly: true });
    try {
      return db.pragma("user_version", { simple: true }) as number;
    } finally {
      db.close();
    }
  };

  it("makes the first manifest of a store from before the llm_revised column the baseline", () => {
    const path = storeAt(3, [
      [SHA_A, 0],
      [SHA_B, 0],
    ]);
    const store = openStore(path);
    expect(store.getDriftBaseline()?.sha).toBe(SHA_A);
    store.close();
    expect(versionOf(path)).toBe(MIGRATIONS.length);
  });

  it.each([4, 5, 6])(
    "leaves the flagged baseline of a store at schema %i where it is",
    (version) => {
      const path = storeAt(version, [
        [SHA_A, 0],
        [SHA_B, 1],
        [SHA_C, 0],
      ]);
      const store = openStore(path);
      expect(store.getDriftBaseline()?.sha).toBe(SHA_B);
      store.close();
      expect(versionOf(path)).toBe(MIGRATIONS.length);
    },
  );

  it("does nothing to a store with no manifest", () => {
    const store = openStore(storeAtSchema7([]));
    expect(store.getDriftBaseline()).toBeNull();
    store.close();
  });
});
