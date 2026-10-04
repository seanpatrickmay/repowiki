import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeManifest, makeRevision, SHA_A } from "@repowiki/core/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

/** renameSync fails once it is armed: the temporary file is written, and never put in place. */
const fail = vi.hoisted(() => ({ rename: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (fail.rename) throw new Error("rename failed");
      return fs.renameSync(...args);
    },
  };
});

const { writeExport } = await import("./export.ts");
const { openStore } = await import("./store.ts");

let dir: string;
afterEach(() => {
  fail.rename = false;
  rmSync(dir, { recursive: true, force: true });
});

describe("writeExport", () => {
  it("leaves the previous export in place when it fails after the temporary file is written", () => {
    dir = mkdtempSync(join(tmpdir(), "repowiki-export-"));
    const store = openStore(":memory:");
    store.putManifest(makeManifest());
    store.putRevision(makeRevision());
    store.setHead(SHA_A);
    const out = join(dir, "export.json");
    writeFileSync(out, "old");
    fail.rename = true;
    try {
      expect(() =>
        writeExport(store, out, { repo: "r", exportedAt: "2026-10-04T00:00:00Z" }),
      ).toThrow("rename failed");
    } finally {
      store.close();
    }
    expect(readFileSync(out, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["export.json"]);
  });
});
