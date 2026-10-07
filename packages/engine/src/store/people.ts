import {
  GitSha,
  PeopleSnapshot,
  PersonRevision,
  queryKeys,
  RegistryRow,
  RepoPath,
  type ResolvedPerson,
  saltedKey,
} from "@repowiki/core";
import type Database from "better-sqlite3";
import { z } from "zod";
import { DuplicateRevisionError, StalePersonParentError, StoreError } from "./errors.ts";

/** A file's blame as the cache keeps it (spec v2 #6 R3): `[commit sha, lines]` runs in order. */
const BlameRuns = z.array(z.tuple([GitSha, z.int().positive()]));

/** People's part of the store (spec v2 #6 R29): migration 10's tables and the salt. */
export interface PeopleStore {
  /** The store's identity salt: 32 random bytes as hex, made once by migration 10 (R10). */
  getPeopleSalt(): string;
  /** Every registry row, oldest first. Private: never exported (spec v2 #6 §5 rule 5). */
  listPeopleRegistry(): RegistryRow[];
  /** Replaces the whole registry. */
  putPeopleRegistry(rows: readonly RegistryRow[]): void;
  /** The latest People snapshot, or null when People is off for this wiki (R24). */
  getPeopleSnapshot(): PeopleSnapshot | null;
  /** Replaces the stored snapshot: one row, the latest. */
  putPeopleSnapshot(snapshot: PeopleSnapshot): void;
  /** Removes the snapshot, turning People off; the registry, revisions and cache stay. */
  clearPeopleSnapshot(): void;
  /**
   * Stores a narrative revision. Its parentId must be the person's current revision id (null for
   * the first), and its id must be new.
   */
  putPersonRevision(revision: PersonRevision): void;
  getCurrentPersonRevision(personId: string): PersonRevision | null;
  /** Each person's current revision, sorted by person id. */
  listCurrentPersonRevisions(): PersonRevision[];
  /** Every revision of one person, oldest first. */
  listPersonHistory(personId: string): PersonRevision[];
  /**
   * Deletes the person's revisions, their registry row and every redirect row pointing at them
   * (wiki:people --forget); returns how many revisions went.
   */
  forgetPerson(personId: string): number;
  /**
   * Deletes the person's narrative revisions and keeps their registry row (a withdrawn consent,
   * planner ruling R18); returns how many went.
   */
  forgetPersonNarrative(personId: string): number;
  /** A file's cached blame by path and blob, or null; a row that does not parse is a miss. */
  getBlameRuns(path: string, oid: string): [string, number][] | null;
  putBlameRuns(path: string, oid: string, runs: readonly (readonly [string, number])[]): void;
  /** Drops every cached blame whose (path, oid) is not in `keep`; returns how many went. */
  pruneBlameCache(keep: readonly { path: string; oid: string }[]): number;
  clearBlameCache(): void;
  /**
   * What a login, name or email resolves to through the registry's salted keys (spec v2 #6 §6):
   * the oldest row holding one of its keys, as a person, a bot or an excluded person; null for
   * nobody. Work in flight's authors are joined to person pages through it (C8).
   */
  resolvePerson(query: { login?: string; name?: string; email?: string }): ResolvedPerson | null;
  /** A People value kept in the store's meta table under `people.<key>`, or null. */
  getPeopleMeta(key: string): string | null;
  setPeopleMeta(key: string, value: string): void;
}

interface BodyRow {
  body: string;
}

const OID = /^[0-9a-f]{40}$/;

/** People's store methods over an open, migrated database. */
export function peopleStore(db: Database.Database): PeopleStore {
  const current = (personId: string): PersonRevision | null => {
    const row = db
      .prepare("SELECT body FROM person_revisions WHERE person_id = ? ORDER BY seq DESC LIMIT 1")
      .get(personId) as BodyRow | undefined;
    return row === undefined ? null : PersonRevision.parse(JSON.parse(row.body));
  };
  const meta = (key: string): string | null => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  };
  const people: PeopleStore = {
    getPeopleSalt() {
      const salt = meta("people.salt");
      if (salt === null || !/^[0-9a-f]{64}$/.test(salt))
        throw new StoreError("the store's People salt is missing or damaged");
      return salt;
    },

    listPeopleRegistry: () =>
      (db.prepare("SELECT body FROM people_registry").all() as BodyRow[])
        .map((row) => RegistryRow.parse(JSON.parse(row.body)))
        .sort((a, b) => a.order - b.order),

    putPeopleRegistry(rows) {
      const parsed = rows.map((row) => RegistryRow.parse(row));
      const ids = new Set(parsed.map((row) => row.id));
      if (ids.size !== parsed.length) throw new StoreError("two registry rows share an id");
      db.transaction(() => {
        db.prepare("DELETE FROM people_registry").run();
        const insert = db.prepare("INSERT INTO people_registry (id, body) VALUES (?, ?)");
        for (const row of parsed) insert.run(row.id, JSON.stringify(row));
      })();
    },

    getPeopleSnapshot() {
      const row = db.prepare("SELECT body FROM people_snapshot").get() as BodyRow | undefined;
      return row === undefined ? null : PeopleSnapshot.parse(JSON.parse(row.body));
    },

    putPeopleSnapshot(snapshot) {
      const parsed = PeopleSnapshot.parse(snapshot);
      db.transaction(() => {
        db.prepare("DELETE FROM people_snapshot").run();
        db.prepare("INSERT INTO people_snapshot (sha, body) VALUES (?, ?)").run(
          parsed.sha,
          JSON.stringify(parsed),
        );
      })();
    },

    clearPeopleSnapshot() {
      db.prepare("DELETE FROM people_snapshot").run();
    },

    putPersonRevision(revision) {
      const parsed = PersonRevision.parse(revision);
      db.transaction(() => {
        if (db.prepare("SELECT 1 FROM person_revisions WHERE id = ?").get(parsed.id) !== undefined)
          throw new DuplicateRevisionError(parsed.id);
        const now = current(parsed.personId)?.id ?? null;
        if (now !== parsed.parentId)
          throw new StalePersonParentError(parsed.personId, now, parsed.parentId);
        db.prepare(
          "INSERT INTO person_revisions (id, person_id, parent_id, body) VALUES (?, ?, ?, ?)",
        ).run(parsed.id, parsed.personId, parsed.parentId, JSON.stringify(parsed));
      })();
    },

    getCurrentPersonRevision: current,

    listCurrentPersonRevisions: () =>
      (
        db
          .prepare(
            `SELECT body FROM person_revisions WHERE seq IN
               (SELECT MAX(seq) FROM person_revisions GROUP BY person_id)
             ORDER BY person_id`,
          )
          .all() as BodyRow[]
      ).map((row) => PersonRevision.parse(JSON.parse(row.body))),

    listPersonHistory: (personId) =>
      (
        db
          .prepare("SELECT body FROM person_revisions WHERE person_id = ? ORDER BY seq")
          .all(personId) as BodyRow[]
      ).map((row) => PersonRevision.parse(JSON.parse(row.body))),

    forgetPerson(personId) {
      return db.transaction(() => {
        const gone = db.prepare("DELETE FROM person_revisions WHERE person_id = ?").run(personId);
        // A redirect to a forgotten id would point nowhere: it goes with the person.
        const dropped = people
          .listPeopleRegistry()
          .filter((r) => r.id === personId || r.to === personId);
        const remove = db.prepare("DELETE FROM people_registry WHERE id = ?");
        for (const r of dropped) remove.run(r.id);
        return gone.changes;
      })();
    },

    forgetPersonNarrative(personId) {
      return db.prepare("DELETE FROM person_revisions WHERE person_id = ?").run(personId).changes;
    },

    resolvePerson(query) {
      const rows = people.listPeopleRegistry();
      if (rows.length === 0) return null;
      const salt = people.getPeopleSalt();
      const keys = new Set(queryKeys(query).map((k) => saltedKey(salt, k)));
      const row = rows.find((r) => r.keys.some((k) => keys.has(k)));
      if (row === undefined) return null;
      if (row.status === "excluded") return { kind: "excluded" };
      return row.kind === "bot" ? { kind: "bot" } : { kind: "person", id: row.id };
    },

    getBlameRuns(path, oid) {
      const row = db
        .prepare("SELECT body FROM blame_cache WHERE path = ? AND oid = ?")
        .get(path, oid) as BodyRow | undefined;
      if (row === undefined) return null;
      try {
        const parsed = BlameRuns.safeParse(JSON.parse(row.body));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    putBlameRuns(path, oid, runs) {
      if (!RepoPath.safeParse(path).success || !OID.test(oid))
        throw new StoreError("a blame cache row needs a repository path and a blob id");
      db.prepare("INSERT OR REPLACE INTO blame_cache (path, oid, body) VALUES (?, ?, ?)").run(
        path,
        oid,
        JSON.stringify(BlameRuns.parse(runs)),
      );
    },

    pruneBlameCache(keep) {
      const kept = new Set(keep.map((k) => `${k.oid}\0${k.path}`));
      const rows = db.prepare("SELECT path, oid FROM blame_cache").all() as {
        path: string;
        oid: string;
      }[];
      const gone = rows.filter((row) => !kept.has(`${row.oid}\0${row.path}`));
      const remove = db.prepare("DELETE FROM blame_cache WHERE path = ? AND oid = ?");
      db.transaction(() => {
        for (const row of gone) remove.run(row.path, row.oid);
      })();
      return gone.length;
    },

    clearBlameCache() {
      db.prepare("DELETE FROM blame_cache").run();
    },

    getPeopleMeta: (key) => meta(`people.${key}`),

    setPeopleMeta(key, value) {
      if (key === "salt") throw new StoreError("the People salt is never replaced");
      db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(`people.${key}`, value);
    },
  };
  return people;
}
