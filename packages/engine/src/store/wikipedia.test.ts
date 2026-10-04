import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, runMigrations } from "./migrations.ts";
import { openStore } from "./store.ts";

const summary = {
  title: "Message queue",
  extract: "A message queue is a form of asynchronous communication.",
  url: "https://en.wikipedia.org/wiki/Message_queue",
};

describe("Wikipedia summary cache", () => {
  it("returns what was cached, including a title with no article, and null otherwise", () => {
    const store = openStore(":memory:");
    store.putWikipediaSummary("Message queue", summary, "2026-10-01T12:00:00Z");
    store.putWikipediaSummary("Made-up thing", null, "2026-10-01T12:00:00Z");
    expect(store.getWikipediaSummary("Message queue")).toEqual({
      summary,
      fetchedAt: "2026-10-01T12:00:00Z",
    });
    expect(store.getWikipediaSummary("Made-up thing")).toEqual({
      summary: null,
      fetchedAt: "2026-10-01T12:00:00Z",
    });
    expect(store.getWikipediaSummary("Never asked")).toBeNull();
    store.close();
  });

  it("validates a summary before caching it", () => {
    const store = openStore(":memory:");
    expect(() =>
      store.putWikipediaSummary(
        "X",
        { ...summary, url: "javascript:alert(1)" },
        "2026-10-01T12:00:00Z",
      ),
    ).toThrow();
    expect(store.getWikipediaSummary("X")).toBeNull();
    store.close();
  });

  it("replaces an earlier lookup of the same title", () => {
    const store = openStore(":memory:");
    store.putWikipediaSummary("Message queue", null, "2026-10-01T12:00:00Z");
    store.putWikipediaSummary("Message queue", summary, "2026-10-02T12:00:00Z");
    expect(store.getWikipediaSummary("Message queue")).toEqual({
      summary,
      fetchedAt: "2026-10-02T12:00:00Z",
    });
    store.close();
  });
});

describe("migration 6", () => {
  it("adds the cache to a store at schema 5 without touching what it holds", () => {
    expect(MIGRATIONS).toHaveLength(6);
    const dir = mkdtempSync(join(tmpdir(), "repowiki-wikipedia-"));
    try {
      const path = join(dir, "store.db");
      const old = new Database(path);
      runMigrations(old, MIGRATIONS.slice(0, 5));
      old.prepare("INSERT INTO meta (key, value) VALUES ('head', 'kept')").run();
      old.close();

      const store = openStore(path);
      expect(store.getWikipediaSummary("Message queue")).toBeNull();
      store.putWikipediaSummary("Message queue", summary, "2026-10-01T12:00:00Z");
      expect(store.getWikipediaSummary("Message queue")?.summary).toEqual(summary);
      store.close();

      const after = new Database(path);
      expect(after.pragma("user_version", { simple: true })).toBe(6);
      expect(after.prepare("SELECT value FROM meta WHERE key = 'head'").get()).toEqual({
        value: "kept",
      });
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
