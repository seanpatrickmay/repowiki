import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOutPath } from "./out-path.ts";

const caseInsensitive = (() => {
  const probe = mkdtempSync(join(os.tmpdir(), "out-path-case-probe-"));
  try {
    return existsSync(join(dirname(probe), basename(probe).toUpperCase()));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe("resolveOutPath", () => {
  let tmpDir: string;
  let repo: string;
  let repoOut: string;
  let elsewhere: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "out-path-test-"));
    repo = join(tmpDir, "repo");
    repoOut = join(tmpDir, "repo-out");
    elsewhere = join(tmpDir, "elsewhere");
    originalCwd = process.cwd();

    // Create directories
    mkdirSync(repo, { recursive: true });
    mkdirSync(repoOut, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("out inside repo returns null", () => {
    const result = resolveOutPath(repo, join(repo, "i.json"));
    expect(result).toBeNull();
  });

  it("out in sibling dir returns its canonical path", () => {
    const result = resolveOutPath(repo, join(repoOut, "i.json"));
    expect(result).not.toBeNull();
    expect(result).toBe(join(realpathSync.native(repoOut), "i.json"));
  });

  it("relative repo dot with relative out index.json returns null", () => {
    process.chdir(repo);
    expect(resolveOutPath(".", "index.json")).toBeNull();
  });

  it("relative repo dot with out in existing subdir returns null", () => {
    mkdirSync(join(repo, "sub"));
    process.chdir(repo);
    expect(resolveOutPath(".", "sub/x.json")).toBeNull();
  });

  it("relative repo dot with out in nonexistent subdir returns null", () => {
    process.chdir(repo);
    expect(resolveOutPath(".", "sub/x.json")).toBeNull();
  });

  it("out written as elsewhere/../repo/i.json returns null", () => {
    const out = `${elsewhere}/../${basename(repo)}/i.json`;
    expect(resolveOutPath(repo, out)).toBeNull();
  });

  it("out through a symlinked ancestor pointing at repo returns null", () => {
    const link = join(elsewhere, "link");
    symlinkSync(repo, link);
    const out = join(link, "i.json");
    expect(resolveOutPath(repo, out)).toBeNull();
  });

  it("out that is a dangling symlink returns null", () => {
    const dangling = join(elsewhere, "dangling");
    symlinkSync(join(repo, "new.json"), dangling);
    // Remove the target to make it dangling
    rmSync(join(repo, "new.json"), { force: true });
    expect(resolveOutPath(repo, dangling)).toBeNull();
  });

  it("out under a dangling symlink ancestor returns null", () => {
    const dl = join(elsewhere, "dl");
    symlinkSync(join(repo, "missingdir"), dl);
    const out = join(dl, "x.json");
    expect(resolveOutPath(repo, out)).toBeNull();
  });

  it("repo given as a symlink with out at the real path returns null", () => {
    const repoLink = join(elsewhere, "repo-link");
    symlinkSync(repo, repoLink);
    const out = join(repo, "i.json");
    expect(resolveOutPath(repoLink, out)).toBeNull();
  });

  it("out equal to repo returns null", () => {
    expect(resolveOutPath(repo, repo)).toBeNull();
  });

  it("nonexistent nested path under repo returns null", () => {
    const out = join(repo, "a", "b", "c.json");
    expect(resolveOutPath(repo, out)).toBeNull();
  });

  it("nonexistent repo returns null", () => {
    const fakeRepo = join(tmpDir, "nonexistent-repo");
    expect(resolveOutPath(fakeRepo, join(fakeRepo, "i.json"))).toBeNull();
  });

  it("out named ..hidden.json inside repo returns null", () => {
    const out = join(repo, "..hidden.json");
    expect(resolveOutPath(repo, out)).toBeNull();
  });

  it("out via link/.. where link points into repo/sub returns canonical elsewhere/x.json", () => {
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const link = join(elsewhere, "link");
    symlinkSync(sub, link);
    // Build path using string concatenation to avoid join() normalization
    const out = `${link}/../x.json`;
    const result = resolveOutPath(repo, out);
    // Path should be outside and equal to canonical elsewhere/x.json
    expect(result).not.toBeNull();
    expect(result).toBe(join(realpathSync.native(elsewhere), "x.json"));
  });

  it("pre-existing regular file inside repo returns null", () => {
    const file = join(repo, "existing.json");
    writeFileSync(file, "{}");
    expect(resolveOutPath(repo, file)).toBeNull();
  });

  it("pre-existing regular file outside repo returns its canonical path", () => {
    const file = join(repoOut, "existing.json");
    writeFileSync(file, "{}");
    const result = resolveOutPath(repo, file);
    expect(result).not.toBeNull();
    expect(result).toBe(realpathSync.native(file));
  });

  it("plain out outside repo returns its canonical path", () => {
    const out = join(elsewhere, "ok.json");
    const result = resolveOutPath(repo, out);
    expect(result).not.toBeNull();
    expect(result).toBe(join(realpathSync.native(elsewhere), "ok.json"));
  });

  it("out that is an existing directory outside repo returns null", () => {
    expect(resolveOutPath(repo, elsewhere)).toBeNull();
  });

  it.skipIf(!caseInsensitive)(
    "repo given in a different case with out at the real path returns null",
    () => {
      const variant = join(tmpDir, basename(repo).toUpperCase());
      expect(resolveOutPath(variant, join(repo, "i.json"))).toBeNull();
    },
  );

  it.skipIf(!caseInsensitive)(
    "out under the real repo with last segment in a different case returns null",
    () => {
      const variant = join(tmpDir, basename(repo).toUpperCase());
      expect(resolveOutPath(repo, join(variant, "i.json"))).toBeNull();
    },
  );

  it.skipIf(!caseInsensitive)(
    "out equal to the repo directory in a different case returns null",
    () => {
      const variant = join(tmpDir, basename(repo).toUpperCase());
      expect(resolveOutPath(repo, variant)).toBeNull();
    },
  );

  describe("anchoring to the enclosing git repository", () => {
    it("repo given as a subdirectory with out at the repo root returns null", () => {
      const sub = join(repo, "sub");
      mkdirSync(sub);
      expect(resolveOutPath(sub, join(repo, "x.json"))).toBeNull();
    });

    it("repo given as a subdirectory with out in a sibling subdirectory returns null", () => {
      mkdirSync(join(repo, "sub"));
      mkdirSync(join(repo, "other"));
      expect(resolveOutPath(join(repo, "sub"), join(repo, "other", "x.json"))).toBeNull();
    });

    it("repo given as a subdirectory with out elsewhere returns the canonical path", () => {
      const sub = join(repo, "sub");
      mkdirSync(sub);
      const out = join(elsewhere, "ok.json");
      expect(resolveOutPath(sub, out)).toBe(join(realpathSync.native(elsewhere), "ok.json"));
    });

    it("a directory that is not in a git repository returns null", () => {
      const plain = join(tmpDir, "plain");
      mkdirSync(plain);
      expect(resolveOutPath(plain, join(elsewhere, "ok.json"))).toBeNull();
    });

    it("a path inside .git returns null", () => {
      expect(resolveOutPath(join(repo, ".git"), join(elsewhere, "ok.json"))).toBeNull();
    });

    it("a bare repository returns null", () => {
      const bare = join(tmpDir, "bare.git");
      execFileSync("git", ["init", "-q", "--bare", bare]);
      expect(resolveOutPath(bare, join(elsewhere, "ok.json"))).toBeNull();
    });
  });
});
