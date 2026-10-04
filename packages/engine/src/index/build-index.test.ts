import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepo } from "./build-index.ts";
import { GitError } from "./git.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
let sha: string;

beforeEach(() => {
  repo = createTestRepo();
  repo.write("src/app/__init__.py", "");
  repo.write("src/app/models.py", "class Thing:\n    def save(self):\n        pass\n");
  repo.write("web/b.ts", "export const b = 1;\n");
  repo.commit("models and b");
  repo.write(
    "src/app/api.py",
    "import os\nfrom .models import Thing\nfrom .models import Thing as T\n",
  );
  repo.write("src/app/models.py", "class Thing:\n    def save(self):\n        return 1\n");
  repo.write("web/a.ts", 'import { b } from "./b";\nimport x from "left-pad";\n');
  repo.write("docs/C#.md", "# C#\n");
  repo.write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]));
  repo.write("big.py", `${"x = 1\n".repeat(100)}`);
  repo.write("broken.py", "def ok():\n    pass\n\ndef broken(:\n");
  sha = repo.commit("api, a, assets");
});
afterEach(() => repo.remove());

describe("indexRepo", () => {
  it("indexes every tracked file, sorted, with member ids", async () => {
    const index = await indexRepo(repo.dir, "HEAD", { maxFileBytes: 200 });
    expect(index.sha).toBe(sha);
    expect(index.files.map((f) => f.id)).toEqual([
      "big.py",
      "broken.py",
      "docs/C%23.md",
      "logo.png",
      "src/app/__init__.py",
      "src/app/api.py",
      "src/app/models.py",
      "web/a.ts",
      "web/b.ts",
    ]);
  });

  it("records symbols with member ids and line spans", async () => {
    const index = await indexRepo(repo.dir, "HEAD");
    const models = index.files.find((f) => f.path === "src/app/models.py");
    expect(models?.symbols.map((s) => [s.id, s.startLine, s.endLine])).toEqual([
      ["src/app/models.py#Thing", 1, 3],
      ["src/app/models.py#Thing.save", 2, 3],
    ]);
    expect(models?.language).toBe("python");
    expect(models?.loc).toBe(3);
  });

  it("does not parse binary or oversized files, and flags syntax errors", async () => {
    const index = await indexRepo(repo.dir, "HEAD", { maxFileBytes: 200 });
    const file = (path: string) => index.files.find((f) => f.path === path);
    expect(file("logo.png")).toMatchObject({
      skipped: "binary",
      loc: 0,
      language: null,
      symbols: [],
    });
    expect(file("big.py")).toMatchObject({ skipped: "too-large", loc: 100, symbols: [] });
    expect(file("broken.py")).toMatchObject({ skipped: null, parseError: true });
    expect(file("broken.py")?.symbols.map((s) => s.qualifiedName)).toContain("ok");
    expect(file("docs/C#.md")).toMatchObject({ language: null, skipped: null, loc: 1 });
  });

  it("records each resolved import once, at its first line", async () => {
    const index = await indexRepo(repo.dir, "HEAD");
    expect(index.imports).toEqual([
      { from: "src/app/api.py", to: "src/app/models.py", line: 2 },
      { from: "web/a.ts", to: "web/b.ts", line: 1 },
    ]);
    expect(index.unresolved).toEqual([
      { from: "src/app/api.py", specifier: "os", line: 1, external: true },
      { from: "web/a.ts", specifier: "left-pad", line: 2, external: true },
    ]);
  });

  it("derives co-change from history", async () => {
    const index = await indexRepo(repo.dir, "HEAD");
    expect(index.coChange.commitsConsidered).toBe(2);
    expect(index.coChange.fileCommits["src/app/models.py"]).toBe(2);
    expect(index.coChange.pairs).toContainEqual({
      a: "src/app/models.py",
      b: "web/b.ts",
      count: 1,
    });
  });

  it("indexes an older commit exactly as it was", async () => {
    const first = repo.git("rev-parse", "HEAD~1");
    const index = await indexRepo(repo.dir, first);
    expect(index.files.map((f) => f.path)).toEqual([
      "src/app/__init__.py",
      "src/app/models.py",
      "web/b.ts",
    ]);
    expect(index.coChange.commitsConsidered).toBe(1);
  });

  it("is deterministic", async () => {
    expect(await indexRepo(repo.dir, sha)).toEqual(await indexRepo(repo.dir, sha));
  });

  it("reads the commit, never the working tree, and leaves the repo untouched", async () => {
    repo.write("web/b.ts", "export const b = 2;\nexport function extra() {}\n");
    repo.write("untracked.py", "def u(): pass\n");
    const status = repo.git("status", "--porcelain=v1", "-uall");
    const gitIndex = join(repo.dir, ".git", "index");
    const before = statSync(gitIndex).mtimeMs;

    const index = await indexRepo(repo.dir, "HEAD");

    // Check the index file before running `git status` again: status itself refreshes it.
    expect(statSync(gitIndex).mtimeMs).toBe(before);
    expect(repo.git("status", "--porcelain=v1", "-uall")).toBe(status);
    const b = index.files.find((f) => f.path === "web/b.ts");
    expect(b?.symbols.map((s) => s.qualifiedName)).toEqual(["b"]);
    expect(index.files.some((f) => f.path === "untracked.py")).toBe(false);
  });

  it("rejects a revision that does not exist", async () => {
    await expect(indexRepo(repo.dir, "no-such-branch")).rejects.toThrow(GitError);
  });
});
