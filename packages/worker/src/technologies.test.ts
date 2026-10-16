import { createTestRepo, type TestRepo } from "@repowiki/engine/test-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { treeTechnologies } from "./technologies.ts";

let repo: TestRepo;
let sha: string;
beforeEach(() => {
  repo = createTestRepo();
  repo.write("package.json", JSON.stringify({ dependencies: { react: "18", zod: "4" } }));
  repo.write("web/package.json", JSON.stringify({ devDependencies: { vitest: "5" } }));
  repo.write("huge/package.json", JSON.stringify({ dependencies: { vue: "x".repeat(300) } }));
  repo.write("crate/Cargo.toml", "[dependencies\nserde = 1\n");
  repo.write("node_modules/x/package.json", JSON.stringify({ dependencies: { svelte: "4" } }));
  repo.write(".github/workflows/ci.yml", "on: push\n");
  repo.write("web/a.tsx", 'import React from "react";\n');
  sha = repo.commit("a project");
});
afterEach(() => repo.remove());

describe("treeTechnologies (ADR-0014)", () => {
  it("reads the tree's manifests at the commit and detects over them and the imports", async () => {
    const found = await treeTechnologies({
      repo: repo.dir,
      sha,
      imports: [{ from: "web/a.tsx", specifier: "react" }],
      maxBytes: 200,
    });
    expect(found.technologies).toEqual([
      { id: "react", evidence: { path: "package.json" }, importingFiles: 1 },
      { id: "vitest", evidence: { path: "web/package.json" }, importingFiles: 0 },
      {
        id: "github-actions",
        evidence: { path: ".github/workflows/ci.yml" },
        importingFiles: null,
      },
    ]);
    expect(found.unparsed).toEqual(["crate/Cargo.toml"]);
    expect(found.tooLarge).toEqual(["huge/package.json"]);
  }, 30_000);

  it("reads at most maxFiles manifests, shallowest first", async () => {
    const found = await treeTechnologies({ repo: repo.dir, sha, imports: null, maxFiles: 1 });
    expect(found.technologies.map((t) => t.id)).toEqual(["react", "zod", "github-actions"]);
  }, 30_000);
});
