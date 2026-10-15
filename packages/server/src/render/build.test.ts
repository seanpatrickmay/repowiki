import { WikiExport } from "@repowiki/core";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { buildTree, renderQueue } from "./build.ts";
import { hostedExport } from "./hosted-export.ts";
import { treeHash } from "./tree.ts";

const exp = WikiExport.parse(fixtureExport());
const entry = new TextEncoder().encode('{"title":"x"}');
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("buildTree (spec 2 S13)", () => {
  it("builds the wiki under site/ with the project's base, adds entry.json, and hashes the tree", async () => {
    const out = await buildTree({
      exp: hostedExport(exp),
      base: "/demo-dev/demo-repo/",
      repoUrl: "https://github.com/demo-dev/demo-repo",
      entry,
    });
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain("entry.json");
    expect(paths).toContain("site/index.html");
    expect(paths.some((p) => p.startsWith("site/wiki/signals/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("site/wiki/deliverables/"))).toBe(true);
    expect(paths.some((p) => p.includes(".repowiki-site"))).toBe(false);
    const file = (path: string) => text(out.files.find((f) => f.path === path)?.bytes);
    expect(file("site/index.html")).toContain("/demo-dev/demo-repo/wiki/");
    // The site publishes the export and llms.txt; the hosted export drops People (M14e A4).
    for (const root of ["site/export.json", "site/llms.txt"]) expect(file(root)).not.toBe("");
    expect(file("site/export.json")).toMatch(/"people": ?null/);
    expect(out.hash).toBe(treeHash(out.files));
  }, 300_000);

  it("runs one job at a time and keeps going after a failure", async () => {
    const order: string[] = [];
    const slow = renderQueue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("first");
      throw new Error("boom");
    });
    const second = renderQueue(async () => {
      order.push("second");
      return 2;
    });
    await expect(slow).rejects.toThrow("boom");
    expect(await second).toBe(2);
    expect(order).toEqual(["first", "second"]);
  });
});
