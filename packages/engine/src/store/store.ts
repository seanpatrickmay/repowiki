import { GitSha, LedgerEntry, Manifest, Revision } from "@repowiki/core";
import Database from "better-sqlite3";
import {
  DroppedFeatureError,
  DuplicateManifestError,
  StaleParentError,
  UnknownFeatureError,
} from "./errors.ts";
import { migrate } from "./migrations.ts";

/** A current claim whose code citation overlaps a queried line range. */
export interface CitingClaim {
  featureId: string;
  revisionId: string;
  claimId: string;
  startLine: number;
  endLine: number;
}

export interface Store {
  close(): void;
  /** Runs fn atomically; nested calls become savepoints. */
  transaction<T>(fn: () => T): T;
  /**
   * Stores a manifest and makes it the latest. Every feature id in the previous latest manifest
   * must still appear: ids are permanent, so retired features stay with a redirect/retired status.
   */
  putManifest(manifest: Manifest): void;
  getManifest(sha: string): Manifest | null;
  getLatestManifest(): Manifest | null;
  /** Appends one LLM call to the token ledger. */
  appendLedger(entry: LedgerEntry): void;
  /** Ledger entries in the order they were appended, optionally only those of one run. */
  listLedger(runId?: string): LedgerEntry[];
  /** The last sha the wiki was built or updated to. */
  setHead(sha: string): void;
  getHead(): string | null;
  /**
   * Stores a revision and makes it current. parentId must equal the feature's current revision id,
   * and the feature must be in the latest stored manifest.
   */
  putRevision(revision: Revision): void;
  getRevision(id: string): Revision | null;
  getCurrentRevision(featureId: string): Revision | null;
  /** Current revision of every feature, sorted by feature id. */
  listCurrentRevisions(): Revision[];
  /** Every revision of a feature, oldest first. */
  listHistory(featureId: string): Revision[];
  /** Current claims with a code citation in path overlapping [startLine, endLine], bounds inclusive. */
  findClaimsCitingRange(path: string, startLine: number, endLine: number): CitingClaim[];
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

  const latestManifest = (): Manifest | null =>
    readManifest(
      db.prepare("SELECT body FROM manifests ORDER BY seq DESC LIMIT 1").get() as
        | BodyRow
        | undefined,
    );

  return {
    close: () => db.close(),
    transaction: (fn) => db.transaction(fn)(),

    putManifest(manifest) {
      const parsed = Manifest.parse(manifest);
      db.transaction(() => {
        if (db.prepare("SELECT 1 FROM manifests WHERE sha = ?").get(parsed.sha) !== undefined) {
          throw new DuplicateManifestError(parsed.sha);
        }
        const previous = latestManifest();
        if (previous !== null) {
          const kept = new Set(parsed.features.map((feature) => feature.id));
          const missing = previous.features.map((f) => f.id).filter((id) => !kept.has(id));
          if (missing.length > 0) throw new DroppedFeatureError(parsed.sha, missing);
        }
        db.prepare(
          "INSERT INTO manifests (sha, seq, body) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM manifests), ?)",
        ).run(parsed.sha, JSON.stringify(parsed));
      })();
    },

    appendLedger(entry) {
      const parsed = LedgerEntry.parse(entry);
      db.prepare("INSERT INTO ledger (run_id, body) VALUES (?, ?)").run(
        parsed.runId,
        JSON.stringify(parsed),
      );
    },

    listLedger: (runId) =>
      (
        (runId === undefined
          ? db.prepare("SELECT body FROM ledger ORDER BY seq").all()
          : db
              .prepare("SELECT body FROM ledger WHERE run_id = ? ORDER BY seq")
              .all(runId)) as BodyRow[]
      ).map((row) => LedgerEntry.parse(JSON.parse(row.body))),

    getManifest: (sha) =>
      readManifest(
        db.prepare("SELECT body FROM manifests WHERE sha = ?").get(sha) as BodyRow | undefined,
      ),

    getLatestManifest: latestManifest,

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
        if (!latestManifest()?.features.some((feature) => feature.id === parsed.featureId)) {
          throw new UnknownFeatureError(parsed.featureId);
        }
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

    findClaimsCitingRange(path, startLine, endLine) {
      if (
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < 1
      ) {
        throw new RangeError(`line bounds must be integers >= 1, got ${startLine}-${endLine}`);
      }
      if (startLine > endLine) throw new RangeError(`startLine ${startLine} > endLine ${endLine}`);
      return db
        .prepare(
          `SELECT r.feature_id AS featureId, c.revision_id AS revisionId, c.claim_id AS claimId,
                  c.start_line AS startLine, c.end_line AS endLine
           FROM citation_ranges c
           JOIN current_revisions cur ON cur.revision_id = c.revision_id
           JOIN revisions r ON r.id = c.revision_id
           WHERE c.path = ? AND c.start_line <= ? AND c.end_line >= ?
           ORDER BY r.feature_id, c.claim_id, c.start_line`,
        )
        .all(path, endLine, startLine) as CitingClaim[];
    },
  };
}
