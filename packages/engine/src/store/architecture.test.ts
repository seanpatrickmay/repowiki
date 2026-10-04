import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  architectureClaim,
  makeArchitecture,
  makeManifest,
  makeRevision,
  SHA_A,
} from "@repowiki/core/test-fixtures";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DuplicateRevisionError,
  StaleArchitectureParentError,
  UnknownFeatureError,
} from "./errors.ts";
import { buildExport } from "./export.ts";
import { MIGRATIONS, runMigrations } from "./migrations.ts";
import { openStore, type Store } from "./store.ts";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
  store.putManifest(makeManifest()); // features: signals, deliverables
});
afterEach(() => store.close());

const ID_1 = "architecture-aaaaaaaaaaaa-1";
const ID_2 = "architecture-aaaaaaaaaaaa-2";
const ID_3 = "architecture-aaaaaaaaaaaa-3";
const first = makeArchitecture();
const second = makeArchitecture({ id: ID_2, parentId: ID_1, reason: "update" });

describe("Architecture revisions", () => {
  it("stores the article, makes the newest current and lists them oldest first", () => {
    expect(store.getCurrentArchitecture()).toBeNull();
    expect(store.listArchitectureHistory()).toEqual([]);
    expect(store.countArchitectureRevisions()).toBe(0);
    store.putArchitecture(first);
    store.putArchitecture(second);
    expect(store.getCurrentArchitecture()).toEqual(second);
    expect(store.listArchitectureHistory().map((a) => a.id)).toEqual([ID_1, ID_2]);
    expect(store.countArchitectureRevisions()).toBe(2);
  });

  it("refuses a parent that is not the current revision", () => {
    expect(() => store.putArchitecture(second)).toThrow(StaleArchitectureParentError);
    store.putArchitecture(first);
    expect(() => store.putArchitecture(makeArchitecture({ id: ID_2 }))).toThrow(
      StaleArchitectureParentError,
    );
  });

  it("refuses a third revision whose parent is the first, keeping the second current", () => {
    store.putArchitecture(first);
    store.putArchitecture(second);
    const fork = makeArchitecture({ id: ID_3, parentId: ID_1, reason: "update" });
    expect(() => store.putArchitecture(fork)).toThrow(StaleArchitectureParentError);
    expect(store.getCurrentArchitecture()).toEqual(second);
    expect(store.listArchitectureHistory().map((a) => a.id)).toEqual([ID_1, ID_2]);
  });

  it("refuses a reused id", () => {
    store.putArchitecture(first);
    expect(() => store.putArchitecture({ ...first, parentId: ID_1 })).toThrow(
      DuplicateRevisionError,
    );
  });

  it("refuses a page or an edge that names a feature outside the manifest, storing nothing", () => {
    const [lead, layers] = first.sections;
    const ghostPage = {
      ...first,
      sections: [
        ...(lead === undefined ? [] : [lead]),
        ...(layers === undefined ? [] : [layers]),
        {
          key: "dependencies" as const,
          claims: [architectureClaim({ id: "a-2", citations: [], pages: ["ghost"] })],
        },
      ],
    };
    expect(() => store.putArchitecture(ghostPage)).toThrow(UnknownFeatureError);
    const ghostEdge = { ...first, edges: [{ from: "ghost", to: "signals", imports: 1, calls: 0 }] };
    expect(() => store.putArchitecture(ghostEdge)).toThrow(UnknownFeatureError);
    expect(store.getCurrentArchitecture()).toBeNull();
  });

  it("parses on write", () => {
    expect(() => store.putArchitecture({ ...first, sections: [] })).toThrow();
  });
});

describe("buildExport with an Architecture article", () => {
  const options = { repo: "demo", exportedAt: "2026-10-02T12:00:00Z" };
  const queue = {
    title: "Message queue",
    extract: "A message queue is a form of asynchronous communication.",
    url: "https://en.wikipedia.org/wiki/Message_queue",
  };

  it("exports every revision, oldest first, and the summaries the current one links", () => {
    store.putRevision(makeRevision());
    store.putRevision(makeRevision({ id: "rev-d", featureId: "deliverables", seeAlso: [] }));
    store.setHead(SHA_A);
    store.putArchitecture(first);
    const linked = makeArchitecture({
      id: ID_2,
      parentId: ID_1,
      reason: "update",
      sections: [
        ...first.sections.slice(0, 1),
        {
          key: "layers",
          claims: [architectureClaim({ text: "Signals go through a [[wp:Message queue]]." })],
        },
      ],
    });
    store.putArchitecture(linked);
    store.putWikipediaSummary("Message queue", queue, "2026-10-01T12:00:00Z");
    const wiki = buildExport(store, options);
    expect(wiki.architecture.map((a) => a.id)).toEqual([ID_1, ID_2]);
    expect(wiki.wikipedia).toEqual({ "Message queue": queue });
  });

  it("gives no summary to a title that only an old revision links", () => {
    store.putRevision(makeRevision());
    store.putRevision(makeRevision({ id: "rev-d", featureId: "deliverables", seeAlso: [] }));
    store.setHead(SHA_A);
    store.putArchitecture(
      makeArchitecture({
        sections: [
          ...first.sections.slice(0, 1),
          {
            key: "layers",
            claims: [architectureClaim({ text: "Signals go through a [[wp:Message queue]]." })],
          },
        ],
      }),
    );
    store.putArchitecture(second);
    store.putWikipediaSummary("Message queue", queue, "2026-10-01T12:00:00Z");
    const wiki = buildExport(store, options);
    expect(wiki.architecture.map((a) => a.id)).toEqual([ID_1, ID_2]);
    expect(wiki.wikipedia).toEqual({});
  });

  it("exports none when no article is stored", () => {
    store.putRevision(makeRevision());
    store.setHead(SHA_A);
    expect(buildExport(store, options).architecture).toEqual([]);
  });
});

describe("migration 7", () => {
  it("adds the table to a store at schema 6 without touching what it holds", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(7);
    const dir = mkdtempSync(join(tmpdir(), "repowiki-architecture-"));
    try {
      const path = join(dir, "store.db");
      const old = new Database(path);
      runMigrations(old, MIGRATIONS.slice(0, 6));
      old.prepare("INSERT INTO meta (key, value) VALUES ('head', 'kept')").run();
      old.close();

      const reopened = openStore(path);
      reopened.putManifest(makeManifest());
      expect(reopened.getCurrentArchitecture()).toBeNull();
      reopened.putArchitecture(first);
      expect(reopened.getCurrentArchitecture()).toEqual(first);
      reopened.close();

      const after = new Database(path);
      expect(after.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      expect(after.prepare("SELECT value FROM meta WHERE key = 'head'").get()).toEqual({
        value: "kept",
      });
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
