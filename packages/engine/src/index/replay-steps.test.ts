import { afterEach, describe, expect, it } from "vitest";
import { replaySteps } from "./diff.ts";
import { GitError } from "./git.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
afterEach(() => repo.remove());

describe("replaySteps", () => {
  it("walks the first-parent merges after `from`, oldest first, then `to` if it is no merge", () => {
    repo = createTestRepo();
    repo.write("a.py", "a = 1\n");
    const root = repo.commit("feat: root");
    const branch = (name: string, file: string, message: string) => {
      repo.git("switch", "-q", "-c", name);
      repo.write(file, `${name} = 1\n`);
      repo.commit(`feat: ${name}`);
      repo.git("switch", "-q", "main");
      return repo.merge(name, message);
    };
    const first = branch("one", "one.py", "Merge pull request #1 from me/one");
    repo.write("direct.py", "d = 1\n");
    repo.commit("fix: a direct commit on main");
    const second = branch("two", "two.py", "Merge branch 'two'");
    repo.write("tip.py", "t = 1\n");
    const tip = repo.commit("chore: tip");

    expect(replaySteps(repo.dir, root, tip)).toEqual([
      { sha: first, subject: "Merge pull request #1 from me/one", merge: true },
      { sha: second, subject: "Merge branch 'two'", merge: true },
      { sha: tip, subject: "chore: tip", merge: false },
    ]);
    // Ending on a merge adds nothing after it; a range with no merge is just `to`.
    expect(replaySteps(repo.dir, root, second).map((s) => s.sha)).toEqual([first, second]);
    expect(replaySteps(repo.dir, second, tip).map((s) => s.sha)).toEqual([tip]);
    expect(replaySteps(repo.dir, tip, tip)).toEqual([]);
    expect(() => replaySteps(repo.dir, tip, root)).toThrow(GitError);
  });

  it("takes an octopus merge as one step", () => {
    repo = createTestRepo();
    repo.write("a.py", "a = 1\n");
    const root = repo.commit("feat: root");
    for (const name of ["left", "right"]) {
      repo.git("switch", "-q", "-c", name, root);
      repo.write(`${name}.py`, `${name} = 1\n`);
      repo.commit(`feat: ${name}`);
    }
    repo.git("switch", "-q", "main");
    repo.git("merge", "-q", "--no-ff", "-m", "Merge branches left and right", "left", "right");
    const octopus = repo.git("rev-parse", "HEAD").trim();
    expect(replaySteps(repo.dir, root, octopus)).toEqual([
      { sha: octopus, subject: "Merge branches left and right", merge: true },
    ]);
  });

  it("refuses a `from` on a diverged branch, and an argument that is not a full sha", () => {
    repo = createTestRepo();
    repo.write("a.py", "a = 1\n");
    const root = repo.commit("feat: root");
    repo.git("switch", "-q", "-c", "side");
    repo.write("side.py", "s = 1\n");
    const side = repo.commit("feat: side");
    repo.git("switch", "-q", "main");
    repo.write("b.py", "b = 1\n");
    const tip = repo.commit("feat: b");
    expect(() => replaySteps(repo.dir, side, tip)).toThrow(GitError);
    for (const bad of ["--output=x", root.slice(0, 7), "main"]) {
      expect(() => replaySteps(repo.dir, bad, tip)).toThrow(GitError);
      expect(() => replaySteps(repo.dir, root, bad)).toThrow(GitError);
    }
  });

  it("ends on the tagged commit when `to` is an annotated tag's own sha", () => {
    repo = createTestRepo();
    repo.write("a.py", "a = 1\n");
    const root = repo.commit("feat: root");
    repo.write("b.py", "b = 1\n");
    const tip = repo.commit("chore: tip");
    repo.git("tag", "-a", "v1", "-m", "release v1", tip);
    const tag = repo.git("rev-parse", "v1").trim();
    expect(tag).not.toBe(tip);
    expect(replaySteps(repo.dir, root, tag)).toEqual([
      { sha: tip, subject: "chore: tip", merge: false },
    ]);
  });

  it("takes each squash-merged pull request, a first-parent commit ending in (#N), as a step", () => {
    repo = createTestRepo();
    repo.write("a.py", "a = 1\n");
    const root = repo.commit("feat: root");
    repo.write("b.py", "b = 1\n");
    const one = repo.commit("feat: add b (#11)");
    repo.write("c.py", "c = 1\n");
    repo.commit("fix: a plain commit on main");
    repo.write("d.py", "d = 1\n");
    const two = repo.commit("Add d (#12)");
    repo.write("e.py", "e = 1\n");
    const tip = repo.commit("chore: tip");
    expect(replaySteps(repo.dir, root, tip)).toEqual([
      { sha: one, subject: "feat: add b (#11)", merge: false },
      { sha: two, subject: "Add d (#12)", merge: false },
      { sha: tip, subject: "chore: tip", merge: false },
    ]);
  });

  it("mixes merge commits and squash commits in first-parent order", () => {
    repo = createTestRepo();
    repo.write("a.py", "a = 1\n");
    const root = repo.commit("feat: root");
    repo.write("b.py", "b = 1\n");
    const squash = repo.commit("feat: add b (#3)");
    repo.git("switch", "-q", "-c", "side");
    repo.write("side.py", "s = 1\n");
    // A squash-looking subject off the first-parent line is not a step: only its merge is.
    repo.commit("feat: side work (#5)");
    repo.git("switch", "-q", "main");
    const merge = repo.merge("side", "Merge pull request #4 from me/side");
    repo.write("c.py", "c = 1\n");
    const plain = repo.commit("fix: no pull request here");
    expect(replaySteps(repo.dir, root, plain)).toEqual([
      { sha: squash, subject: "feat: add b (#3)", merge: false },
      { sha: merge, subject: "Merge pull request #4 from me/side", merge: true },
      { sha: plain, subject: "fix: no pull request here", merge: false },
    ]);
    // A plain commit is not a step unless it is `to`.
    expect(replaySteps(repo.dir, root, merge).map((s) => s.sha)).toEqual([squash, merge]);
  });
});
