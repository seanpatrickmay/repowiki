import { WikiExport } from "@repowiki/core";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { buildTree, renderQueue } from "./build.ts";
import { hostedExport } from "./hosted-export.ts";
import { treeHash } from "./tree.ts";

const exp = WikiExport.parse(fixtureExport());
const portfolio = new TextEncoder().encode('{"title":"x"}');
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("buildTree (spec 2 S13)", () => {
  it("builds the wiki under docs/ with the public base, adds portfolio.json, and hashes the tree", async () => {
    const out = await buildTree({
      exp: hostedExport(exp),
      base: "/demo-dev/demo-repo/docs/",
      repoUrl: "https://github.com/demo-dev/demo-repo",
      portfolio,
    });
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain("portfolio.json");
    expect(paths).toContain("docs/index.html");
    expect(paths.some((p) => p.startsWith("docs/wiki/signals/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("docs/wiki/deliverables/"))).toBe(true);
    expect(paths.some((p) => p.includes(".repowiki-site"))).toBe(false);
    const file = (path: string) => text(out.files.find((f) => f.path === path)?.bytes);
    expect(file("docs/index.html")).toContain("/demo-dev/demo-repo/docs/");
    // The site publishes the export and llms.txt; the hosted export drops People (M14e A4).
    for (const root of ["docs/export.json", "docs/llms.txt"]) expect(file(root)).not.toBe("");
    expect(file("docs/export.json")).toMatch(/"people": ?null/);
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
