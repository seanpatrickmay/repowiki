import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeManifest } from "@repowiki/core/test-fixtures";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { UnsupportedSchemaError } from "./errors.ts";
import { MIGRATIONS } from "./migrations.ts";
import { openStore } from "./store.ts";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-store-"));
  dirs.push(dir);
  return join(dir, "wiki.db");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("brings a new database to the latest schema version", () => {
    const path = tempDbPath();
    openStore(path).close();
    const db = new Database(path);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });

  it("keeps data across reopen without re-running migrations", () => {
    const path = tempDbPath();
    const first = openStore(path);
    first.putManifest(makeManifest());
    first.close();
    const second = openStore(path);
    expect(second.getManifest(makeManifest().sha)).toEqual(makeManifest());
    second.close();
  });

  it("refuses a database written by a newer RepoWiki and leaves it untouched", () => {
    const path = tempDbPath();
    const db = new Database(path);
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    const bytesBefore = readFileSync(path);
    const filesBefore = readdirSync(dirname(path));
    expect(() => openStore(path)).toThrow(UnsupportedSchemaError);
    expect(readFileSync(path).equals(bytesBefore)).toBe(true);
    expect(readdirSync(dirname(path))).toEqual(filesBefore);
    const after = new Database(path);
    expect(after.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length + 1);
    after.close();
  });
});
