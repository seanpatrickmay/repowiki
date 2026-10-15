import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fsObjectStore } from "./fs-store.ts";
import { assertKey, contentTypeFor, copyPrefix, type ObjectStore } from "./store.ts";

const HTML = "text/html; charset=utf-8";
const BAD_KEYS = [
  "",
  "/a",
  "a/../b",
  "..",
  "../a",
  "a\\b",
  "a//b",
  "a/./b",
  "a/",
  `a${"x".repeat(600)}`,
];

let parent: string;
let root: string;
let store: ObjectStore;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "objects-"));
  root = join(parent, "root");
  store = fsObjectStore(root);
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

describe("object keys (spec 2 S12)", () => {
  it("refuse traversal, absolute paths, backslashes and empties", () => {
    for (const bad of BAD_KEYS) expect(() => assertKey(bad), bad).toThrow();
    expect(() => assertKey("sites/p/v1/wiki/index.html")).not.toThrow();
    expect(() => assertKey("exports/00000000-0000-4000-8000-000000000001-1.json")).not.toThrow();
  });

  it("map extensions to content types", () => {
    expect(contentTypeFor("a/index.html")).toBe(HTML);
    expect(contentTypeFor("a/x.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("a/x.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("a/export.json")).toBe("application/json");
    expect(contentTypeFor("a/x.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("a/x.pf_index")).toBe("application/octet-stream");
    expect(contentTypeFor("a/README")).toBe("application/octet-stream");
  });
});

describe("the filesystem store (spec 2 S12)", () => {
  it("puts, gets, heads, lists and deletes", async () => {
    await store.put("sites/p/v1/index.html", "<h1>x</h1>", HTML);
    await store.put("sites/p/v1/wiki/a.html", new Uint8Array([97]), HTML);
    await store.put("sites/pq/v1/index.html", "q", HTML);
    const got = await store.get("sites/p/v1/index.html");
    expect(Buffer.from(got?.body ?? []).toString()).toBe("<h1>x</h1>");
    expect(got?.contentType).toBe(HTML);
    expect(await store.head("sites/p/v1/index.html")).toEqual({ contentType: HTML, size: 10 });
    expect(await store.get("sites/p/v1/missing.html")).toBeNull();
    expect(await store.head("sites/p/v1")).toBeNull();
    expect(await store.list("sites/p/")).toEqual([
      "sites/p/v1/index.html",
      "sites/p/v1/wiki/a.html",
    ]);
    expect(await store.list("sites/p")).toHaveLength(3);
    expect(await store.list("nothing/here/")).toEqual([]);
    await store.delete(["sites/p/v1/index.html", "sites/p/v1/never.html"]);
    expect(await store.list("sites/p/")).toEqual(["sites/p/v1/wiki/a.html"]);
  });

  it("refuse a bad key before touching the disk", async () => {
    for (const bad of BAD_KEYS) {
      await expect(store.put(bad, "x", HTML), bad).rejects.toThrow("invalid object key");
      await expect(store.get(bad), bad).rejects.toThrow("invalid object key");
      await expect(store.delete([bad]), bad).rejects.toThrow("invalid object key");
    }
    await expect(store.list("../")).rejects.toThrow("invalid object key");
    expect(existsSync(join(parent, "a"))).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it("copies a prefix", async () => {
    await store.put("previews/p/r1/index.html", "x", HTML);
    await store.put("previews/p/r1/wiki/a.html", "a", HTML);
    expect(await copyPrefix(store, "previews/p/r1/", "sites/p/v1/")).toBe(2);
    expect(await store.list("sites/p/v1/")).toEqual([
      "sites/p/v1/index.html",
      "sites/p/v1/wiki/a.html",
    ]);
    expect(Buffer.from((await store.get("sites/p/v1/wiki/a.html"))?.body ?? []).toString()).toBe(
      "a",
    );
  });

  it("copies only whole directories: both prefixes must end with a slash", async () => {
    await store.put("previews/p/r1/index.html", "1", HTML);
    await store.put("previews/p/r10/index.html", "10", HTML);
    await expect(copyPrefix(store, "previews/p/r1", "sites/p/v1/")).rejects.toThrow("end with /");
    await expect(copyPrefix(store, "previews/p/r1/", "sites/p/v1")).rejects.toThrow("end with /");
    expect(await copyPrefix(store, "previews/p/r1/", "sites/p/v1/")).toBe(1);
    expect(await store.list("sites/p/")).toEqual(["sites/p/v1/index.html"]);
  });
});
