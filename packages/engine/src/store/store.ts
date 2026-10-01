import { GitSha, Manifest, Revision } from "@repowiki/core";
import Database from "better-sqlite3";
import { DuplicateManifestError, StaleParentError } from "./errors.ts";
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
  /** Stores a revision and makes it current. parentId must equal the feature's current revision id. */
  putRevision(revision: Revision): void;
  getRevision(id: string): Revision | null;
  getCurrentRevision(featureId: string): Revision | null;
  /** Current revision of every feature, sorted by feature id. */
  listCurrentRevisions(): Revision[];
  /** Every revision of a feature, oldest first. */
  listHistory(featureId: string): Revision[];
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

  const readRevision = (row: BodyRow | undefined): Revision | null =>
    row === undefined ? null : Revision.parse(JSON.parse(row.body));

  const currentRevisionId = (featureId: string): string | null => {
    const row = db
      .prepare("SELECT revision_id FROM current_revisions WHERE feature_id = ?")
      .get(featureId) as { revision_id: string } | undefined;
    return row?.revision_id ?? null;
  };

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

    putRevision(revision) {
      const parsed = Revision.parse(revision);
      db.transaction(() => {
        const current = currentRevisionId(parsed.featureId);
        if (current !== parsed.parentId) {
          throw new StaleParentError(parsed.featureId, current, parsed.parentId);
        }
        db.prepare(
          "INSERT INTO revisions (id, feature_id, parent_id, body) VALUES (?, ?, ?, ?)",
        ).run(parsed.id, parsed.featureId, parsed.parentId, JSON.stringify(parsed));
        const insertRange = db.prepare(
          "INSERT INTO citation_ranges (revision_id, claim_id, path, start_line, end_line) VALUES (?, ?, ?, ?, ?)",
        );
        for (const section of parsed.sections) {
          for (const claim of section.claims) {
            for (const citation of claim.citations) {
              if (citation.kind !== "code") continue;
              insertRange.run(
                parsed.id,
                claim.id,
                citation.path,
                citation.startLine,
                citation.endLine,
              );
            }
          }
        }
        db.prepare(
          "INSERT INTO current_revisions (feature_id, revision_id) VALUES (?, ?) ON CONFLICT(feature_id) DO UPDATE SET revision_id = excluded.revision_id",
        ).run(parsed.featureId, parsed.id);
      })();
    },

    getRevision: (id) =>
      readRevision(
        db.prepare("SELECT body FROM revisions WHERE id = ?").get(id) as BodyRow | undefined,
      ),

    getCurrentRevision: (featureId) =>
      readRevision(
        db
          .prepare(
            "SELECT r.body FROM current_revisions c JOIN revisions r ON r.id = c.revision_id WHERE c.feature_id = ?",
          )
          .get(featureId) as BodyRow | undefined,
      ),

    listCurrentRevisions: () =>
      (
        db
          .prepare(
            "SELECT r.body FROM current_revisions c JOIN revisions r ON r.id = c.revision_id ORDER BY c.feature_id",
          )
          .all() as BodyRow[]
      ).map((row) => Revision.parse(JSON.parse(row.body))),

    listHistory: (featureId) =>
      (
        db
          .prepare("SELECT body FROM revisions WHERE feature_id = ? ORDER BY rowid")
          .all(featureId) as BodyRow[]
      ).map((row) => Revision.parse(JSON.parse(row.body))),
  };
}
