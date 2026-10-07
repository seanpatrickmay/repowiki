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
  baseRef,
  ensureInflightRepo,
  FETCH_TIMEOUT_MS,
  fetchHeads,
  githubFetchUrl,
  headStates,
  INFLIGHT_DIR,
  INFLIGHT_GIT,
  INFLIGHT_GIT_ENV,
  INFLIGHT_READ_TIMEOUT_MS,
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
    const tree = inflightGit(dir, ["config", "--get", "attr.tree"]);
    expect([tree.status, tree.stdout]).toEqual([0, "\n"]);
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

  it("fetches each pull request's base by its oid in the same one call (R27)", async () => {
    const main = fx.pushPull(90, fx.first, { "b.txt": "b\n" });
    const a = fx.pushPull(1, main, { "c.txt": "c\n" });
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    const log = join(fx.out, "git-calls.txt");
    script(
      join(fx.out, "bin"),
      "git",
      `case " $* " in *" fetch "*) echo fetch >> '${log}';; esac\nexec '${realGit()}' "$@"`,
    );
    await withEnv({ PATH: `${join(fx.out, "bin")}:${process.env.PATH ?? ""}` }, () => {
      const { heads, problem } = fetchHeads(
        dir,
        fx.url,
        [{ number: 1, headRefOid: a, baseRefOid: main }],
        FILE,
      );
      expect(problem).toBeNull();
      expect(heads.get(1)).toBe("fetched");
    });
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    expect(inflightGit(dir, ["rev-parse", baseRef(1)]).stdout.trim()).toBe(main);
    // A base the remote cannot serve (a force-pushed branch) leaves the head fetched, and the
    // refresh then treats the base as unknown.
    const gone = { number: 1, headRefOid: a, baseRefOid: "e".repeat(40) };
    expect(fetchHeads(dir, fx.url, [gone], FILE).heads.get(1)).toBe("fetched");
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

  it("stops fetching one by one at the first failure that is not a missing ref", async () => {
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    const log = join(fx.out, "git-calls.txt");
    // The batch fails on a missing ref; every later fetch hangs (a network that went away).
    script(
      join(fx.out, "bin"),
      "git",
      `case " $* " in *" fetch "*) echo fetch >> '${log}'; [ "$(wc -l < '${log}')" -eq 1 ] && { echo "fatal: couldn't find remote ref refs/pull/9/head" >&2; exit 128; }; exec /bin/sleep 30;; esac\nexec '${realGit()}' "$@"`,
    );
    const pulls = [1, 2, 3].map((number) => ({ number, headRefOid: "e".repeat(40) }));
    await withEnv({ PATH: `${join(fx.out, "bin")}:${process.env.PATH ?? ""}` }, () => {
      const { problem } = fetchHeads(dir, fx.url, pulls, { protocol: "file", timeoutMs: 500 });
      expect(problem).toBe("git fetch timed out after 0.5 s");
    });
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("runs gh's credential helper with gh's scrubbed variables, and drops TLS and trace overrides", async () => {
    const bin = join(fx.out, "bin");
    const seen = join(fx.out, "gh-env.txt");
    script(bin, "gh", `/usr/bin/env > '${seen}'\nexit 0`);
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
        GIT_ALLOW_PROTOCOL: "http",
        GH_HOST: "evil.example",
        GH_DEBUG: "api",
        GH_PAGER: "cat",
        GH_ENTERPRISE_TOKEN: "enterprise-value",
        GIT_SSL_NO_VERIFY: "1",
        GIT_TRACE_CURL: join(fx.out, "curl-trace.txt"),
        GIT_TRACE_REDACT: "0",
      };
      await withEnv(env, () => {
        const dir = ensureInflightRepo(fx.out, fx.repo.dir);
        const url = `http://127.0.0.1:${port}/acme/demo.git`;
        fetchHeads(dir, url, [{ number: 1, headRefOid: fx.first }], {
          protocol: "http",
          timeoutMs: 20_000,
        });
      });
      const vars = new Map(
        readFileSync(seen, "utf8")
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      for (const name of [
        "GH_HOST",
        "GH_DEBUG",
        "GH_PAGER",
        "GH_ENTERPRISE_TOKEN",
        "GIT_SSL_NO_VERIFY",
        "GIT_TRACE_CURL",
        "GIT_TRACE_REDACT",
      ])
        expect(vars.has(name), name).toBe(false);
      expect([vars.get("GH_PROMPT_DISABLED"), vars.get("NO_COLOR")]).toEqual(["1", "1"]);
      expect(existsSync(join(fx.out, "curl-trace.txt"))).toBe(false);
    } finally {
      server.kill();
    }
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

  it("says so when it cannot delete the refs of a pull request no longer open", async () => {
    const a = fx.pushPull(1, fx.first, { "a.py": "a\n" });
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    fetchHeads(dir, fx.url, [{ number: 1, headRefOid: a }], FILE);
    script(
      join(fx.out, "bin"),
      "git",
      `case " $* " in *" update-ref "*) echo "fatal: cannot lock ref" >&2; exit 128;; esac\nexec '${realGit()}' "$@"`,
    );
    await withEnv({ PATH: `${join(fx.out, "bin")}:${process.env.PATH ?? ""}` }, () => {
      expect(fetchHeads(dir, fx.url, [], FILE).problem).toBe(
        "could not delete the refs of closed pull requests: fatal: cannot lock ref",
      );
    });
  });

  it("never uses a transport other than the one it allows, so GIT_ALLOW_PROTOCOL=file stops https (C13)", () => {
    const saved = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file";
    try {
      const dir = ensureInflightRepo(fx.out, fx.repo.dir);
      expect(githubFetchUrl({ owner: "acme", name: "demo" })).toBe(
        "https://github.com/acme/demo.git",
      );
      // A local https URL: were the protocol check ever to let it through, nothing leaves the host.
      const url = "https://127.0.0.1:9/acme/demo.git";
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
      execFileSync("git", ["-C", dir, "ls-remote", url], {
        stdio: "ignore",
        env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
      });
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

describe("INFLIGHT_GIT and inflightGit's time limit", () => {
  it("names inflight.git by --git-dir for the index module's reads, and limits each read", async () => {
    expect(INFLIGHT_GIT).toEqual({
      env: INFLIGHT_GIT_ENV,
      gitDir: true,
      timeoutMs: INFLIGHT_READ_TIMEOUT_MS,
    });
    expect([INFLIGHT_READ_TIMEOUT_MS, FETCH_TIMEOUT_MS]).toEqual([120_000, 600_000]);
    const dir = ensureInflightRepo(fx.out, fx.repo.dir);
    script(join(fx.out, "bin"), "git", "exec /bin/sleep 30");
    await withEnv({ PATH: `${join(fx.out, "bin")}:${process.env.PATH ?? ""}` }, () => {
      const out = inflightGit(dir, ["rev-parse", "HEAD"], { timeoutMs: 300 });
      expect([out.status, out.timedOut]).toEqual([null, true]);
    });
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

  it.each([
    "fatal: not a git repository",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: Not a valid object name refs/repowiki/pull/9",
  ])("is false for any other failure: %s", (message) => {
    expect(isMissingObject(new Error(message))).toBe(false);
  });
});
