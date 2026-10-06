import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRepo } from "../index/index.ts";
import {
  ensureInflightRepo,
  fetchHeads,
  githubFetchUrl,
  headStates,
  INFLIGHT_DIR,
  inflightGit,
  isMissingObject,
  pullRef,
  removeInflightRepo,
} from "./heads.ts";
import { type InflightFixture, inflightFixture, listing } from "./test-inflight.ts";

// Each test builds a fixture wiki, a remote and inflight.git: seconds on a loaded machine.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let fx: InflightFixture;
beforeEach(async () => {
  fx = await inflightFixture();
});
afterEach(() => fx.remove());

const FILE = { protocol: "file" } as const;

/** Every file under `dir` with a hash of its bytes: "byte-identical" is checked by it. */
function contents(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((path) => statSync(join(dir, path)).isFile())
    .map(
      (path) =>
        `${path} ${createHash("sha256")
          .update(readFileSync(join(dir, path)))
          .digest("hex")}`,
    )
    .sort();
}

/** Sets `vars` on process.env for `body` (undefined deletes one), then puts back what was there. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => T | Promise<T>) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const put = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  put(vars);
  try {
    return await body();
  } finally {
    put(saved);
  }
}

/** An executable script `name` in `dir`. */
function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
  return join(dir, name);
}

const realGit = () => execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

describe("ensureInflightRepo (R5)", () => {
  it("creates a bare repository borrowing the documented repository's objects", () => {
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    expect(dir).toBe(join(fx.out, INFLIGHT_DIR));
    expect(inflightGit(dir, ["rev-parse", "--is-bare-repository"]).stdout.trim()).toBe("true");
    expect(readFileSync(join(dir, "objects", "info", "alternates"), "utf8").trim()).toBe(
      join(
        execFileSync("git", ["-C", fx.repo.dir, "rev-parse", "--absolute-git-dir"], {
          encoding: "utf8",
        }).trim(),
        "objects",
      ),
    );
    // The documented repository's commit is readable from inflight.git through the alternates.
    expect(inflightGit(dir, ["cat-file", "-t", fx.first]).stdout.trim()).toBe("commit");
    const config = (key: string) => inflightGit(dir, ["config", "--get", key]).stdout.trim();
    expect([config("gc.auto"), config("core.hooksPath"), config("core.attributesFile")]).toEqual([
      "0",
      "/dev/null",
      "/dev/null",
    ]);
    expect(existsSync(join(dir, "hooks"))).toBe(false);
  });

  it("re-creates a broken one and never falls through to the repository around the out dir", () => {
    const a = fx.pushPull(1, fx.first, { "a.py": "a\n" });
    const around = createTestRepo();
    try {
      around.write("x.txt", "x\n");
      around.commit("around");
      const out = join(around.dir, "out");
      const dir = ensureInflightRepo(out, fx.repo.dir);
      // HEAD is still there, refs/ is not (an interrupted delete): git would not call it a repo.
      rmSync(join(dir, "refs"), { recursive: true, force: true });
      const git = join(around.dir, ".git");
      const before = [readFileSync(join(git, "config")), contents(join(git, "refs"))];
      const objects = contents(join(git, "objects"));
      expect(ensureInflightRepo(out, fx.repo.dir)).toBe(dir);
      expect(inflightGit(dir, ["rev-parse", "--is-bare-repository"]).stdout.trim()).toBe("true");
      expect(fetchHeads(dir, fx.url, [{ number: 1, headRefOid: a }], FILE).heads.get(1)).toBe(
        "fetched",
      );
      expect([readFileSync(join(git, "config")), contents(join(git, "refs"))]).toEqual(before);
      expect(contents(join(git, "objects"))).toEqual(objects);
      expect(existsSync(join(git, "packed-refs"))).toBe(false);
    } finally {
      around.remove();
    }
  });

  it("keeps an existing one, and replaces a directory that is not a repository", () => {
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    writeFileSync(join(dir, "marker"), "");
    ensureInflightRepo(fx.out, fx.repo.dir);
    expect(existsSync(join(dir, "marker"))).toBe(true);
    removeInflightRepo(dir);
    expect(existsSync(dir)).toBe(false);
    ensureInflightRepo(fx.out, fx.repo.dir);
    expect(existsSync(join(dir, "HEAD"))).toBe(true);
  });
});

describe("fetchHeads (R6)", () => {
  it("fetches every head in one call into refs/repowiki/pull/<n>, writing nothing in the documented repo", () => {
    const a = fx.pushPull(1, fx.first, { "src/new.py": "x = 1\n" });
    const b = fx.pushPull(2, fx.first, { "docs/signals.md": "# Signals\n" });
    const before = listing(join(fx.repo.dir, ".git"));
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    const { heads, problem } = fetchHeads(
      dir,
      fx.url,
      [
        { number: 1, headRefOid: a },
        { number: 2, headRefOid: b },
      ],
      FILE,
    );
    expect(problem).toBeNull();
    expect([...heads]).toEqual([
      [1, "fetched"],
      [2, "fetched"],
    ]);
    expect(inflightGit(dir, ["rev-parse", pullRef(1)]).stdout.trim()).toBe(a);
    // The pull request's own objects landed in inflight.git, not in the documented repository.
    expect(inflightGit(dir, ["cat-file", "-p", `${a}:src/new.py`]).stdout).toBe("x = 1\n");
    expect(() =>
      execFileSync("git", ["-C", fx.repo.dir, "cat-file", "-e", a], { stdio: "ignore" }),
    ).toThrow();
    expect(listing(join(fx.repo.dir, ".git"))).toEqual(before);
  });

  it("fetches the rest one by one when one pull request has closed, and marks it missing", () => {
    const a = fx.pushPull(1, fx.first, { "src/new.py": "x = 1\n" });
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    const { heads, problem } = fetchHeads(
      dir,
      fx.url,
      [
        { number: 1, headRefOid: a },
        { number: 9, headRefOid: "f".repeat(40) },
      ],
      FILE,
    );
    expect(problem).toMatch(/couldn't find remote ref refs\/pull\/9\/head/);
    expect([...heads]).toEqual([
      [1, "fetched"],
      [9, "missing"],
    ]);
  });

  it("fetches one by one only after a missing ref, never after a timeout or another failure", async () => {
    const a = fx.pushPull(1, fx.first, { "a.py": "a\n" });
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    // An earlier run's head, so a "moved" re-fetch would be due too.
    fetchHeads(dir, fx.url, [{ number: 1, headRefOid: a }], FILE);
    const log = join(fx.out, "git-calls.txt");
    const bin = script(
      join(fx.out, "bin"),
      "git",
      `case " $* " in *" fetch "*) echo fetch >> '${log}'; [ -n "$SLOW_FETCH" ] && exec /bin/sleep 30;; esac\nexec '${realGit()}' "$@"`,
    );
    const pulls = [
      { number: 1, headRefOid: "e".repeat(40) },
      { number: 2, headRefOid: "f".repeat(40) },
    ];
    const fetches = () => readFileSync(log, "utf8").trim().split("\n").length;
    await withEnv({ PATH: `${join(fx.out, "bin")}:${process.env.PATH ?? ""}` }, async () => {
      expect(bin).toBe(join(fx.out, "bin", "git"));
      const gone = `file://${join(fx.out, "no-such-remote.git")}`;
      const refused = fetchHeads(dir, gone, pulls, FILE);
      expect(fetches()).toBe(1);
      expect(refused.problem).toMatch(/does not appear to be a git repository/);
      rmSync(log);
      await withEnv({ SLOW_FETCH: "1" }, () => {
        const slow = fetchHeads(dir, fx.url, pulls, { protocol: "file", timeoutMs: 500 });
        expect(fetches()).toBe(1);
        expect(slow.problem).toBe("git fetch timed out after 0.5 s");
      });
    });
  });

  it("never asks the user's askpass programs, even when gh gives no credential (R6)", async () => {
    const bin = join(fx.out, "bin");
    const marker = join(fx.out, "askpass-ran");
    const askpass = script(bin, "askpass", `echo "$@" >> '${marker}'\necho secret`);
    script(bin, "gh", "exit 0");
    // A local server that asks for credentials; a child process, as the fetch blocks this one.
    const server = spawn(
      process.execPath,
      [
        "-e",
        `require("node:http").createServer((q, s) => { s.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' }); s.end(); }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const port = await new Promise<string>((resolve) =>
        server.stdout.once("data", (data) => resolve(String(data).trim())),
      );
      const env = {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GIT_ASKPASS: askpass,
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: "force",
        GIT_ALLOW_PROTOCOL: "http",
      };
      await withEnv(env, () => {
        const dir = ensureInflightRepo(fx.out, fx.repo.dir);
        const url = `http://127.0.0.1:${port}/acme/demo.git`;
        const { heads, problem } = fetchHeads(dir, url, [{ number: 1, headRefOid: fx.first }], {
          protocol: "http",
          timeoutMs: 20_000,
        });
        expect(heads.get(1)).toBe("missing");
        expect(problem).toMatch(/terminal prompts disabled/);
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      server.kill();
    }
  });

  it("marks a head that moved since GitHub was read, after fetching it once more", () => {
    const old = fx.pushPull(1, fx.first, { "src/new.py": "x = 1\n" });
    fx.pushPull(1, fx.first, { "src/new.py": "x = 2\n" });
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    expect(fetchHeads(dir, fx.url, [{ number: 1, headRefOid: old }], FILE).heads.get(1)).toBe(
      "moved",
    );
  });

  it("deletes the refs of pull requests no longer open", () => {
    const a = fx.pushPull(1, fx.first, { "a.py": "a\n" });
    const b = fx.pushPull(2, fx.first, { "b.py": "b\n" });
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    fetchHeads(
      dir,
      fx.url,
      [
        { number: 1, headRefOid: a },
        { number: 2, headRefOid: b },
      ],
      FILE,
    );
    fetchHeads(dir, fx.url, [{ number: 2, headRefOid: b }], FILE);
    const refs = inflightGit(dir, ["for-each-ref", "--format=%(refname)"]).stdout.trim();
    expect(refs).toBe(pullRef(2));
  });

  it("never uses a transport other than the one it allows, so GIT_ALLOW_PROTOCOL=file stops https (C13)", () => {
    const saved = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file";
    try {
      const dir = ensureInflightRepo(fx.out, fx.repo.dir);
      const url = githubFetchUrl({ owner: "acme", name: "demo" });
      expect(url).toBe("https://github.com/acme/demo.git");
      const { heads, problem } = fetchHeads(dir, url, [{ number: 1, headRefOid: fx.first }]);
      expect(heads.get(1)).toBe("missing");
      expect(problem).toMatch(/transport 'https' not allowed/);
    } finally {
      if (saved === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = saved;
    }
  });

  it("ignores the user's global config, so url.insteadOf cannot rewrite the built URL (C13)", () => {
    const a = fx.pushPull(1, fx.first, { "a.py": "a\n" });
    const url = "https://github.com/acme/demo.git";
    const global = join(fx.out, "global.gitconfig");
    writeFileSync(
      global,
      `[url "${fx.url}"]\n\tinsteadOf = ${url}\n[protocol]\n\tallow = always\n`,
    );
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
      const dir = ensureInflightRepo(fx.out, fx.repo.dir);
      // Control: a plain git honours the rewrite and would fetch from the file remote.
      execFileSync("git", ["-C", dir, "ls-remote", url], { stdio: "ignore", env: process.env });
      const { heads } = fetchHeads(dir, url, [{ number: 1, headRefOid: a }], {
        protocol: "file",
        timeoutMs: 20_000,
      });
      expect(heads.get(1)).toBe("missing");
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
  });
});

describe("headStates (offline)", () => {
  it("reads fetched, moved and missing heads from inflight.git with no network", () => {
    const a = fx.pushPull(1, fx.first, { "a.py": "a\n" });
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    fetchHeads(dir, fx.url, [{ number: 1, headRefOid: a }], FILE);
    const pulls = [
      { number: 1, headRefOid: a },
      { number: 1, headRefOid: fx.first },
      { number: 3, headRefOid: a },
    ];
    expect([...headStates(dir, pulls.slice(0, 1))]).toEqual([[1, "fetched"]]);
    expect([...headStates(dir, pulls.slice(1, 2))]).toEqual([[1, "moved"]]);
    expect([...headStates(dir, pulls.slice(2))]).toEqual([[3, "missing"]]);
    expect([...headStates(join(fx.out, "nowhere.git"), pulls.slice(0, 1))]).toEqual([
      [1, "missing"],
    ]);
  });
});

describe("isMissingObject", () => {
  it.each([
    "fatal: bad object 0123",
    "error: unable to read tree 0123",
    "fatal: could not fetch 0123abcd from promisor remote",
    "fatal: loose object 0123 (stored in x) is corrupt",
    "fatal: Not a valid commit name 0123",
  ])("knows %s", (message) => {
    expect(isMissingObject(new Error(message))).toBe(true);
  });

  it("is false for any other failure", () => {
    expect(isMissingObject(new Error("fatal: not a git repository"))).toBe(false);
  });
});
