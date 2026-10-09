import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExportLoadError, loadExport } from "./load.ts";
import { type SampleWiki, sampleWiki } from "./test-wiki.ts";

let sample: SampleWiki;
let dir: string;
beforeAll(() => {
  sample = sampleWiki();
  dir = mkdtempSync(join(tmpdir(), "repowiki-load-"));
});
afterAll(() => {
  sample.repo.remove();
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, text: string) => {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};

describe("loadExport", () => {
  it("reads and validates an export", () => {
    const file = write("export.json", JSON.stringify(sample.wiki));
    expect(loadExport(file)).toEqual(sample.wiki);
  });

  it("names a missing file, a file that is not JSON, and an invalid export with its path", () => {
    expect(() => loadExport(join(dir, "missing.json"))).toThrow(ExportLoadError);
    expect(() => loadExport(write("bad.json", "{"))).toThrow(/^cannot read export .*bad\.json/);
    const invalid = write("invalid.json", JSON.stringify({ ...sample.wiki, head: "nope" }));
    expect(() => loadExport(invalid)).toThrow(/^invalid export .*invalid\.json: head: /);
  });

  it("names another schema version first, with what to do", () => {
    const older = write("older.json", JSON.stringify({ ...sample.wiki, schemaVersion: 2 }));
    expect(() => loadExport(older)).toThrow(
      `export schema 2 in ${older} is older than this reader (3); re-run the export`,
    );
    const newer = write("newer.json", JSON.stringify({ ...sample.wiki, schemaVersion: 4 }));
    expect(() => loadExport(newer)).toThrow(/is newer than this reader \(3\); upgrade RepoWiki$/);
  });
});
