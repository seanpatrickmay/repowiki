import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiExport } from "@repowiki/core";
import {
  bodyClaim,
  leadClaim,
  makeManifest,
  makeRevision,
  SHA_A,
  SHA_B,
} from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmptyStoreError } from "./errors.ts";
import { buildExport, writeExport } from "./export.ts";
import { openStore, type Store } from "./store.ts";

const options = { repo: "next-chief-of-staff", exportedAt: "2026-09-30T21:00:00Z" };
let store: Store;
let dir: string;
beforeEach(() => {
  store = openStore(":memory:");
  dir = mkdtempSync(join(tmpdir(), "repowiki-export-"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  store.putManifest(makeManifest());
  store.putRevision(makeRevision());
  store.putRevision(
    makeRevision({ id: "rev-2", parentId: "rev-1", reason: "update", sha: SHA_B, pr: 88 }),
  );
  store.setHead(SHA_B);
}

describe("buildExport", () => {
  it("refuses to export an empty store", () => {
    expect(() => buildExport(store, options)).toThrow(EmptyStoreError);
  });

  it("refuses to export a manifest with no head", () => {
    store.putManifest(makeManifest());
    expect(() => buildExport(store, options)).toThrow(EmptyStoreError);
  });

  it("exports current pages with oldest-first history", () => {
    seed();
    const wiki = buildExport(store, options);
    expect(wiki.schemaVersion).toBe(3);
    expect(wiki.head).toBe(SHA_B);
    expect(wiki.manifest.sha).toBe(SHA_A);
    expect(wiki.pages.map((p) => p.id)).toEqual(["rev-2"]);
    expect(wiki.history.signals?.map((r) => [r.id, r.sha, r.reason, r.pr])).toEqual([
      ["rev-1", SHA_A, "build", null],
      ["rev-2", SHA_B, "update", 88],
    ]);
  });

  it("exports full revision bodies, so past versions can be read and diffed", () => {
    seed();
    const wiki = buildExport(store, options);
    expect(wiki.history.signals?.[0]).toEqual(store.getRevision("rev-1"));
    expect(wiki.history.signals?.at(-1)).toEqual(wiki.pages[0]);
  });
});

describe("writeExport", () => {
  it("writes valid, newline-terminated JSON, creating parent directories", () => {
    seed();
    const out = join(dir, "nested", "export.json");
    writeExport(store, out, options);
    const text = readFileSync(out, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(WikiExport.parse(JSON.parse(text))).toEqual(buildExport(store, options));
  });
});

describe("buildExport Wikipedia summaries (F13)", () => {
  const queue = {
    title: "Message queue",
    extract: "A message queue is a form of asynchronous communication.",
    url: "https://en.wikipedia.org/wiki/Message_queue",
  };

  it("exports the cached summary of every Wikipedia article a current page links", () => {
    store.putManifest(makeManifest());
    store.putRevision(
      makeRevision({
        sections: [
          { key: "lead", claims: [leadClaim({ text: "Uses a [[wp:Message queue|queue]]." })] },
          {
            key: "overview",
            claims: [bodyClaim({ text: "Runs on [[wp:Cron]] and [[wp:Gone]]." })],
          },
        ],
      }),
    );
    store.setHead(SHA_A);
    store.putWikipediaSummary("Message queue", queue, "2026-10-01T12:00:00Z");
    store.putWikipediaSummary("Gone", null, "2026-10-01T12:00:00Z");
    store.putWikipediaSummary("Unlinked", { ...queue, title: "Unlinked" }, "2026-10-01T12:00:00Z");
    expect(buildExport(store, options).wikipedia).toEqual({ "Message queue": queue });
  });
});

describe("buildExport Wikipedia titles are read as the site reads link tokens", () => {
  const entry = (title: string) => ({
    title,
    extract: `${title} is a thing.`,
    url: `https://en.wikipedia.org/wiki/${title.replaceAll(" ", "_")}`,
  });
  const fetchedAt = "2026-10-01T12:00:00Z";

  function seedPages(leadText: string, bodyText: string): void {
    store.putManifest(makeManifest());
    store.putRevision(
      makeRevision({
        sections: [
          { key: "lead", claims: [leadClaim({ text: leadText })] },
          { key: "overview", claims: [bodyClaim({ text: bodyText })] },
        ],
      }),
    );
    store.setHead(SHA_A);
  }

  it("keys a summary by the normalized title, ignores code spans, and reads through placeholders", () => {
    seedPages(
      "Uses [[wp:message_queue|a queue]] and `[[wp:Hidden]]`.",
      "Also [[wp:Dead letter queue]], [[wp:Cron]] and [\ue000[wp:Event loop]].",
    );
    for (const title of ["Message queue", "Hidden", "Dead letter queue", "Event loop"]) {
      store.putWikipediaSummary(title, entry(title), fetchedAt);
    }
    expect(Object.keys(buildExport(store, options).wikipedia)).toEqual([
      "Dead letter queue",
      "Event loop",
      "Message queue",
    ]);
  });

  it("leaves out an article only an older revision linked", () => {
    store.putManifest(makeManifest());
    store.putRevision(
      makeRevision({
        sections: [
          { key: "lead", claims: [leadClaim({ text: "Old [[wp:Cron]]." })] },
          { key: "overview", claims: [bodyClaim()] },
        ],
      }),
    );
    store.putRevision(makeRevision({ id: "rev-2", parentId: "rev-1", reason: "update" }));
    store.setHead(SHA_A);
    store.putWikipediaSummary("Cron", entry("Cron"), fetchedAt);
    expect(buildExport(store, options).wikipedia).toEqual({});
  });

  it("exports no summaries when nothing was cached", () => {
    seedPages("Uses [[wp:Cron]].", "Plain.");
    expect(buildExport(store, options).wikipedia).toEqual({});
  });
});
