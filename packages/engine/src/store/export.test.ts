import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiExport } from "@repowiki/core";
import { makeManifest, makeRevision, SHA_A, SHA_B } from "@repowiki/core/test-fixtures";
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
    expect(wiki.schemaVersion).toBe(2);
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
