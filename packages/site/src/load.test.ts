import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ExportError, loadExport } from "./load.ts";
import { fixtureExport } from "./test-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "repowiki-load-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe("loadExport", () => {
  it("parses a valid export, given the file or its directory", () => {
    const file = write("export.json", JSON.stringify(fixtureExport()));
    expect(loadExport(file)).toEqual(fixtureExport());
    expect(loadExport(dir)).toEqual(fixtureExport());
  });

  it("names the file and the failing field for a schema violation", () => {
    const pages = fixtureExport().pages.map((page) => ({ ...page, commitDate: "yesterday" }));
    const file = write("bad.json", JSON.stringify({ ...fixtureExport(), pages }));
    expect(() => loadExport(file)).toThrow(ExportError);
    expect(() => loadExport(file)).toThrow(/invalid export .*bad\.json[\s\S]*commitDate/);
  });

  it("rejects an export from an older schema version", () => {
    const file = write("v1.json", JSON.stringify({ ...fixtureExport(), schemaVersion: 1 }));
    expect(() => loadExport(file)).toThrow(/schemaVersion/);
  });

  it("reports unreadable and non-JSON files as ExportError", () => {
    expect(() => loadExport(join(dir, "missing.json"))).toThrow(/cannot read export/);
    expect(() => loadExport(write("junk.json", "{"))).toThrow(/cannot read export/);
  });
});
