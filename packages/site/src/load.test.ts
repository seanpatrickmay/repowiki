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

  it("rejects a v1 export with one line that names the file and says to re-export", () => {
    // v1 history held { id, sha, commitDate, reason, pr } entries rather than whole revisions.
    const wiki = fixtureExport();
    const history = Object.fromEntries(
      Object.entries(wiki.history).map(([id, revisions]) => [
        id,
        revisions.map(({ id, sha, commitDate, reason, pr }) => ({
          id,
          sha,
          commitDate,
          reason,
          pr,
        })),
      ]),
    );
    const file = write("v1.json", JSON.stringify({ ...wiki, schemaVersion: 1, history }));
    expect(() => loadExport(file)).toThrow(ExportError);
    expect(() => loadExport(file)).toThrow(
      new ExportError(
        `export schema 1 in ${file} is older than this reader (3); re-run the export`,
      ),
    );
  });

  it("rejects an export from a newer schema version the same way", () => {
    const file = write("v4.json", JSON.stringify({ ...fixtureExport(), schemaVersion: 4 }));
    expect(() => loadExport(file)).toThrow(
      new ExportError(`export schema 4 in ${file} is newer than this reader (3); upgrade RepoWiki`),
    );
  });

  it("leaves a missing or non-numeric schemaVersion to the schema check", () => {
    const file = write("v0.json", JSON.stringify({ ...fixtureExport(), schemaVersion: "2" }));
    expect(() => loadExport(file)).toThrow(/invalid export [\s\S]*schemaVersion/);
  });

  it("reports unreadable and non-JSON files as ExportError", () => {
    expect(() => loadExport(join(dir, "missing.json"))).toThrow(/cannot read export/);
    expect(() => loadExport(write("junk.json", "{"))).toThrow(/cannot read export/);
  });
});
