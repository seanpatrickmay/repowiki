import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SearchIndexApi, writeSearchIndex } from "./search-index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "repowiki-search-index-"));
  for (const n of [1, 2, 3]) {
    mkdirSync(join(dir, `p${n}`));
    writeFileSync(
      join(dir, `p${n}`, "index.html"),
      `<html lang="en"><body><article data-pagefind-body><h1>Page ${n}</h1><p>signal ${n}</p></article></body></html>`,
    );
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Every file under outDir/pagefind, relative to it. */
function bundleFiles(outDir: string): string[] {
  return readdirSync(join(outDir, "pagefind"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(join(outDir, "pagefind").length + 1));
}

describe("writeSearchIndex", () => {
  // Pagefind's backend answers writeFiles before it has finished writing (issue #342): the
  // promise resolves while pagefind-entry.json is still empty, and the build then kills the
  // backend. The index must be on disk, whole, by the time writeSearchIndex returns.
  it("has written the whole bundle when it returns, even if the backend writes late", async () => {
    const entry = Buffer.from('{"version":"x","languages":{"en":{"page_count":3}}}');
    const lateWrites: Promise<void>[] = [];
    // A variable, not a literal in place: the build no longer calls writeFiles, so SearchIndexApi
    // leaves it out, but this backend still has it and answers it late.
    const index = {
      addDirectory: async () => ({ errors: [], page_count: 3 }),
      writeFiles: async ({ outputPath }: { outputPath: string }) => {
        // Like the real backend: respond now, finish the write later.
        lateWrites.push(
          new Promise((done) =>
            setTimeout(() => {
              mkdirSync(outputPath, { recursive: true });
              writeFileSync(join(outputPath, "pagefind-entry.json"), entry);
              done();
            }, 100),
          ),
        );
        return { errors: [] };
      },
      getFiles: async () => ({
        errors: [],
        files: [{ path: "pagefind-entry.json", content: entry }],
      }),
    };
    const fake: SearchIndexApi = {
      createIndex: async () => ({ errors: [], index }),
      close: async () => {},
    };
    await writeSearchIndex(dir, fake);
    expect(readFileSync(join(dir, "pagefind", "pagefind-entry.json"))).toEqual(entry);
    await Promise.all(lateWrites);
  });

  it("indexes the pages marked data-pagefind-body and reports how many HTML pages it read", async () => {
    const { htmlPages } = await writeSearchIndex(dir);
    expect(htmlPages).toBe(3);
    const entry = JSON.parse(readFileSync(join(dir, "pagefind", "pagefind-entry.json"), "utf8"));
    expect(entry.languages.en.page_count).toBe(3);
    expect(bundleFiles(dir)).toContain("pagefind.js");
  });

  it.each([
    "../escape.txt",
    "fragment/../../escape.txt",
    "/tmp/escape.txt",
    "..",
    ".",
    "fragment/..",
  ])("refuses a bundle file path that escapes the output directory: %s", async (path) => {
    const index = {
      addDirectory: async () => ({ errors: [], page_count: 1 }),
      getFiles: async () => ({
        errors: [],
        files: [
          { path: "pagefind-entry.json", content: Buffer.from("{}") },
          { path, content: Buffer.from("x") },
        ],
      }),
    };
    const fake: SearchIndexApi = {
      createIndex: async () => ({ errors: [], index }),
      close: async () => {},
    };
    await expect(writeSearchIndex(dir, fake)).rejects.toThrow(
      `pagefind: refusing to write outside the output directory: "${path}"`,
    );
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
    expect(existsSync(join(dir, "pagefind"))).toBe(false);
  });

  it("accepts a file whose name merely starts with two dots", async () => {
    const index = {
      addDirectory: async () => ({ errors: [], page_count: 1 }),
      getFiles: async () => ({
        errors: [],
        files: [{ path: "..foo/..bar.json", content: Buffer.from("{}") }],
      }),
    };
    const fake: SearchIndexApi = {
      createIndex: async () => ({ errors: [], index }),
      close: async () => {},
    };
    await writeSearchIndex(dir, fake);
    expect(readFileSync(join(dir, "pagefind", "..foo", "..bar.json"), "utf8")).toBe("{}");
  });

  it("reports a Pagefind error and still closes the backend", async () => {
    let closed = false;
    const fake: SearchIndexApi = {
      createIndex: async () => ({
        errors: [],
        index: {
          addDirectory: async () => ({ errors: ["no html"], page_count: 0 }),
          writeFiles: async () => ({ errors: [] }),
          getFiles: async () => ({ errors: [], files: [] }),
        },
      }),
      close: async () => {
        closed = true;
      },
    };
    await expect(writeSearchIndex(dir, fake)).rejects.toThrow("pagefind: no html");
    expect(closed).toBe(true);
  });
});
