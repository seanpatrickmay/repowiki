import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WikiExport } from "@repowiki/core";
import { INGEST_PY } from "@repowiki/core/test-fixtures";
import { ensureInflightRepo, fetchHeads, openStore } from "@repowiki/engine";
import { type InflightFixture, inflightFixture, listing } from "@repowiki/engine/test-inflight";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test builds a fixture wiki and runs the command as a process: seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SCRIPT = fileURLToPath(new URL("./wiki-inflight.ts", import.meta.url));
const FIXTURES = fileURLToPath(
  new URL("../packages/engine/src/github/__fixtures__/", import.meta.url),
);
/** Every GitHub body in the fixtures carries it; no output may (R13). */
const CANARY = "CANARY-BODY-7f3a";

let fx: InflightFixture;
let bin: string;
let gitDir: string[];
beforeEach(async () => {
  fx = await inflightFixture({ onDisk: true });
  // A PATH with git and, when a test writes one, a fake gh: never the machine's own gh.
  bin = join(fx.out, "..", "bin");
  mkdirSync(bin);
  const git = (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, "git"))
    .find((path) => existsSync(path));
  if (git === undefined) throw new Error("the tests need git on PATH");
  symlinkSync(realpathSync(git), join(bin, "git"));
  // Pull request #12 is pushed and already in inflight.git: the command's own https fetch is
  // refused (GIT_ALLOW_PROTOCOL=file), so its heads stand as inflight.git holds them.
  const head = fx.pushPull(12, fx.first, {
    "src/signals/ingest.py": INGEST_PY.replace("    signals = []", "    signals = list()"),
  });
  fetchHeads(ensureInflightRepo(fx.out, fx.repo.dir), fx.url, [{ number: 12, headRefOid: head }], {
    protocol: "file",
  });
  const pulls = readFileSync(join(FIXTURES, "pulls.json"), "utf8").replace("c".repeat(40), head);
  writeFileSync(join(bin, "pulls.json"), pulls);
  gitDir = listing(join(fx.repo.dir, ".git"));
});
afterEach(() => fx.remove());

/** A fake gh: the two queries' fixture answers, or `exit` with a message for any call. */
function fakeGh(exit: number | null = null): void {
  const path = join(bin, "gh");
  const answer =
    exit === null
      ? [
          'case "$*" in',
          `  *"pullRequests("*) exec /bin/cat "${join(bin, "pulls.json")}" ;;`,
          `  *after=*) exec /bin/cat "${join(FIXTURES, "issues-2.json")}" ;;`,
          `  *) exec /bin/cat "${join(FIXTURES, "issues-1.json")}" ;;`,
          "esac",
        ]
      : [`echo "gh: called with $1" >&2`, `exit ${exit}`];
  writeFileSync(
    path,
    ["#!/bin/sh", `/usr/bin/touch "${join(bin, "called")}"`, ...answer, ""].join("\n"),
  );
  chmodSync(path, 0o755);
}

function run(...args: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (!/^(ANTHROPIC_.*|(HTTP|HTTPS|ALL|NO)_PROXY|GH_.*|GITHUB_.*|REPOWIKI_CASSETTE)$/i.test(name))
      env[name] = value;
  const result = spawnSync(process.execPath, [SCRIPT, fx.repo.dir, "--out", fx.out, ...args], {
    encoding: "utf8",
    env: { ...env, PATH: bin, HOME: join(fx.out, ".."), GIT_ALLOW_PROTOCOL: "file" },
  });
  // Nothing the command prints carries a GitHub body, and it never writes in the repository.
  expect(`${result.stdout}${result.stderr}`).not.toContain(CANARY);
  expect(listing(join(fx.repo.dir, ".git"))).toEqual(gitDir);
  return result;
}
const stored = () => {
  const store = openStore(join(fx.out, "wiki.db"));
  try {
    return { snapshot: store.getGitHubSnapshot(), inflight: store.getInFlight() };
  } finally {
    store.close();
  }
};
const exportText = () => readFileSync(join(fx.out, "export.json"), "utf8");

describe("wiki-inflight.ts as a process (no network)", () => {
  it("states the estimate on a dry run and stores and exports nothing", () => {
    fakeGh();
    const result = run("--github", "acme/demo", "--dry-run");
    expect(result.status).toBe(0);
    expect(result.stderr.split("\n").slice(0, 3)).toEqual([
      "acme/demo: 3 open pull requests, 3 open issues; 1 malformed entry dropped",
      expect.stringMatching(
        /^pull-request heads: 1 fetched, 2 missing, 0 moved since GitHub was read; the fetch said: /,
      ),
      expect.stringMatching(/^1 pull-request summary \(0 cached, 1 to request\): about \$0\.00/),
    ]);
    expect(stored()).toEqual({ snapshot: null, inflight: null });
    expect(existsSync(join(fx.out, "export.json"))).toBe(false);
  });

  it("fails once with no key when a summary is due, and summarizes nothing", () => {
    fakeGh();
    const result = run("--github", "acme/demo");
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").at(-1)).toMatch(
      /^ANTHROPIC_API_KEY is not set: pnpm wiki:inflight .* scripts\/wiki-inflight\.ts$/,
    );
    expect(stored().inflight).toBeNull();
  });

  it("stores and exports the snapshot with --no-llm, its hostile text inert, then re-derives it offline", () => {
    fakeGh();
    const result = run("--github", "acme/demo", "--no-llm");
    expect(result.status).toBe(0);
    const table = result.stdout.split("\n");
    // Newest first; the hostile title is one line in a code span, its controls gone (R13).
    expect(table.slice(2, 4)).toEqual([
      "| `#13 <script>alert(1)</script> exe.txt [[signals]] [click](javascript:alert(1)) second line` | none | not computed (head missing) | none |",
      "| `#12 Page through long chunks` | `signals` | 2 | not asked |",
    ]);
    expect(table.every((line) => /^[\x20-\x7e]*$/.test(line))).toBe(true);
    expect(result.stdout).toContain("0 new summaries, $0.0000");
    const wiki = WikiExport.parse(JSON.parse(exportText()));
    expect(wiki.inflight?.pulls.map((p) => [p.number, p.head])).toEqual([
      [13, "missing"],
      [12, "fetched"],
      [14, "missing"],
    ]);
    expect(exportText()).not.toContain(CANARY);
    expect(readFileSync(join(fx.out, "llms.txt"), "utf8")).not.toMatch(/CANARY|#12|in flight/i);

    fakeGh(1);
    rmSync(join(bin, "called"), { force: true });
    const offline = run("--offline");
    expect(offline.status).toBe(0);
    expect(existsSync(join(bin, "called"))).toBe(false);
    expect(stored().inflight?.pulls).toHaveLength(3);
  });

  it.each([
    [null, "the repository has no origin remote; pass --github owner/name"],
    ["missing", "gh is not installed (no gh on PATH)"],
    [4, "gh is not logged in to github.com; run gh auth login"],
  ] as const)("skips, exit 0, changing nothing, when GitHub cannot be read (%s)", (gh, reason) => {
    if (typeof gh === "number") fakeGh(gh);
    const result = run(...(gh === null ? [] : ["--github", "acme/demo"]));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`work in flight skipped: ${reason}\n`);
    expect(stored()).toEqual({ snapshot: null, inflight: null });
    expect(existsSync(join(fx.out, "export.json"))).toBe(false);
  });

  it("clears the snapshot and inflight.git with --clear", () => {
    fakeGh();
    expect(run("--github", "acme/demo", "--no-llm").status).toBe(0);
    const result = run("--clear");
    expect(result.status).toBe(0);
    expect(stored()).toEqual({ snapshot: null, inflight: null });
    expect(existsSync(join(fx.out, "inflight.git"))).toBe(false);
    expect(WikiExport.parse(JSON.parse(exportText())).inflight).toBeNull();
  });

  it("is a usage error, exit 2, for a bad flag, and never echoes its value", () => {
    const result = run("--max-usd", "1000");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(
      /^--max-usd must be a number of dollars above 0 and up to 100; usage: pnpm wiki:inflight /,
    );
  });
});
