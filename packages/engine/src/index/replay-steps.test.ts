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
});
