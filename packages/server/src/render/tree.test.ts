import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTree, type TreeFile, treeHash } from "./tree.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const a: TreeFile = { path: "a.html", bytes: enc("A") };
const c: TreeFile = { path: "b/c.css", bytes: enc("C") };

describe("tree hashing (spec 2 S13)", () => {
  it("is independent of file order and changes with any path or byte", () => {
    expect(treeHash([a, c])).toMatch(/^[0-9a-f]{64}$/);
    expect(treeHash([c, a])).toBe(treeHash([a, c]));
    expect(treeHash([{ path: "a.html", bytes: enc("B") }, c])).not.toBe(treeHash([a, c]));
    expect(treeHash([{ path: "z.html", bytes: enc("A") }, c])).not.toBe(treeHash([a, c]));
    expect(treeHash([a])).not.toBe(treeHash([a, c]));
  });

  it("reads a directory as sorted posix paths with a prefix, skipping the site marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-"));
    mkdirSync(join(dir, "x"));
    writeFileSync(join(dir, "x", "1.txt"), "1");
    writeFileSync(join(dir, "0.txt"), "0");
    writeFileSync(join(dir, ".repowiki-site"), "m");
    expect(readTree(dir, "docs/").map((f) => f.path)).toEqual(["docs/0.txt", "docs/x/1.txt"]);
  });
});
