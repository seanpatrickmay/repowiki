import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StoreError } from "./errors.ts";
import { openStore } from "./store.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-open-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("openStore driver errors (issue #53)", () => {
  it("reports a file that is not SQLite as a StoreError naming the path", () => {
    const path = join(tempDir(), "wiki.db");
    writeFileSync(path, "this is not a database, just some text that is long enough\n".repeat(20));
    expect(() => openStore(path)).toThrow(StoreError);
    expect(() => openStore(path)).toThrow(`cannot open ${path} as a RepoWiki store`);
  });

  it("reports a path whose directory does not exist as a StoreError", () => {
    const path = join(tempDir(), "missing", "wiki.db");
    const error = (() => {
      try {
        openStore(path);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(StoreError);
    expect((error as Error).cause).toBeInstanceOf(Error);
  });
});
