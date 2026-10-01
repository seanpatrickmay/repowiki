import { GitSha, Manifest } from "@repowiki/core";
import Database from "better-sqlite3";
import { DuplicateManifestError } from "./errors.ts";
import { migrate } from "./migrations.ts";

export interface Store {
  close(): void;
  /** Runs fn atomically; nested calls become savepoints. */
  transaction<T>(fn: () => T): T;
  putManifest(manifest: Manifest): void;
  getManifest(sha: string): Manifest | null;
  getLatestManifest(): Manifest | null;
  /** The last sha the wiki was built or updated to. */
  setHead(sha: string): void;
  getHead(): string | null;
}

interface BodyRow {
  body: string;
}

export function openStore(path: string): Store {
  const db = new Database(path);
  try {
    // Migrate before switching to WAL: refusing a newer schema must not touch the file.
    migrate(db);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  } catch (error) {
    db.close();
    throw error;
  }

  const readManifest = (row: BodyRow | undefined): Manifest | null =>
    row === undefined ? null : Manifest.parse(JSON.parse(row.body));

  return {
    close: () => db.close(),
    transaction: (fn) => db.transaction(fn)(),

    putManifest(manifest) {
      const parsed = Manifest.parse(manifest);
      if (db.prepare("SELECT 1 FROM manifests WHERE sha = ?").get(parsed.sha) !== undefined) {
        throw new DuplicateManifestError(parsed.sha);
      }
      db.prepare(
        "INSERT INTO manifests (sha, seq, body) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM manifests), ?)",
      ).run(parsed.sha, JSON.stringify(parsed));
    },

    getManifest: (sha) =>
      readManifest(
        db.prepare("SELECT body FROM manifests WHERE sha = ?").get(sha) as BodyRow | undefined,
      ),

    getLatestManifest: () =>
      readManifest(
        db.prepare("SELECT body FROM manifests ORDER BY seq DESC LIMIT 1").get() as
          | BodyRow
          | undefined,
      ),

    setHead(sha) {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('head', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(GitSha.parse(sha));
    },

    getHead() {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'head'").get() as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
  };
}
