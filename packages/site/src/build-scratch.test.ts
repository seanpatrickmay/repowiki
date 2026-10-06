import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fixtureExport } from "./test-fixtures.ts";

/** The scratch export copy a --no-inflight build writes: the next one fails, and is recorded. */
const scratch = vi.hoisted(() => ({ failNext: false, written: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const real: typeof import("node:fs") = await importOriginal();
  return {
    ...real,
    writeFileSync: ((path: string, data: never, options?: never) => {
      if (scratch.failNext && basename(dirname(String(path))).startsWith("repowiki-site-")) {
        scratch.failNext = false;
        scratch.written = String(path);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return real.writeFileSync(path, data, options);
    }) as typeof real.writeFileSync,
  };
});

const { buildSite } = await import("./build.ts");

const dir = mkdtempSync(join(tmpdir(), "repowiki-scratch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("buildSite --no-inflight's scratch copy", () => {
  it("is removed even when writing it fails", async () => {
    const exportFile = join(dir, "export.json");
    writeFileSync(exportFile, `${JSON.stringify(fixtureExport())}\n`);
    scratch.failNext = true;
    await expect(
      buildSite(exportFile, join(dir, "share"), null, { inflight: false }),
    ).rejects.toThrow(/ENOSPC/);
    expect(scratch.written).not.toBeNull();
    expect(existsSync(dirname(scratch.written ?? ""))).toBe(false);
  });
});
