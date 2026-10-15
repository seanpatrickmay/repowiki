import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloneBare } from "./clone.ts";

const SHA = "a".repeat(40);
const URL = "https://github.com/demo-dev/demo-repo.git";

/**
 * A fake git: `clone` dumps its environment and argv (one per line), writes `bytes` into the
 * target, then sleeps `after` seconds; `cat-file` knows SHA. Every call's argv goes to `log`.
 */
function fakeGit(
  options: { bytes?: number; sleep?: number; after?: number; fail?: boolean; stderr?: string } = {},
): { git: string; log: string; env: string; argv: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-git-"));
  const git = join(dir, "git");
  const log = join(dir, "argv.log");
  const env = join(dir, "clone-env");
  const argv = join(dir, "clone-argv");
  writeFileSync(
    git,
    `#!/bin/sh
echo "$@" >> '${log}'
case "$*" in
  *" clone "*)
    env > '${env}'
    printf '%s\\n' "$@" > '${argv}'
    ${options.sleep ? `sleep ${options.sleep}` : ""}
    ${options.stderr ? `echo '${options.stderr}' >&2` : ""}
    ${options.fail ? "exit 128" : ""}
    for last; do :; done
    mkdir -p "$last" && head -c ${options.bytes ?? 10} /dev/zero > "$last/pack"
    ${options.after ? `sleep ${options.after}` : ""} ;;
  *cat-file*${SHA}*) exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(git, 0o755);
  return { git, log, env, argv };
}

const work = () => mkdtempSync(join(tmpdir(), "work-"));
const base = (dir: string, git: string) => ({
  url: URL,
  sha: SHA,
  dir: join(dir, "repo", "demo-repo"),
  sizeKb: 1,
  home: dir,
  git,
});

describe("cloneBare (spec 2 S9)", () => {
  it("clones bare without tags, with https only, and checks the commit is there", async () => {
    const { git, log } = fakeGit();
    expect(await cloneBare(base(work(), git))).toEqual({ ok: true });
    const argv = readFileSync(log, "utf8");
    expect(argv).toContain("clone --bare --no-tags");
    expect(argv).toContain("protocol.allow=never");
    expect(argv).toContain(`cat-file -e ${SHA}^{commit}`);
  });

  it("runs git with the given home, no user or system config, no prompt, and -- before the URL", async () => {
    const fake = fakeGit();
    const dir = work();
    expect(await cloneBare(base(dir, fake.git))).toEqual({ ok: true });
    const env = readFileSync(fake.env, "utf8").split("\n");
    for (const line of [
      `HOME=${dir}`,
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_TERMINAL_PROMPT=0",
    ])
      expect(env).toContain(line);
    expect(env.filter((l) => /^(REPOWIKI_|ANTHROPIC_)/.test(l))).toEqual([]);
    const argv = readFileSync(fake.argv, "utf8").split("\n");
    expect(argv.slice(argv.indexOf(URL) - 1, argv.indexOf(URL) + 2)).toEqual([
      "--",
      URL,
      join(dir, "repo", "demo-repo"),
    ]);
  });

  it("stops a clone that grows past the limit while it runs, and calls a full disk too large", async () => {
    const growing = fakeGit({ bytes: 4096, after: 30 });
    const dir = work();
    const started = Date.now();
    expect(
      await cloneBare({ ...base(dir, growing.git), maxBytes: 1024, pollMs: 50 }),
    ).toMatchObject({ ok: false, code: "repo-too-large" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(join(dir, "repo", "demo-repo"))).toBe(false);
    const full = fakeGit({ fail: true, stderr: "fatal: write error: No space left on device" });
    expect(await cloneBare(base(work(), full.git))).toMatchObject({
      ok: false,
      code: "repo-too-large",
    });
  }, 30_000);

  it("refuses before cloning when GitHub reports the repository too large", async () => {
    const { git, log } = fakeGit();
    const result = await cloneBare({ ...base(work(), git), sizeKb: 600 * 1024 });
    expect(result).toMatchObject({ ok: false, code: "repo-too-large" });
    expect(existsSync(log)).toBe(false);
  });

  it("refuses and deletes a clone that turns out larger than the limit", async () => {
    const { git } = fakeGit({ bytes: 4096 });
    const dir = work();
    const result = await cloneBare({ ...base(dir, git), maxBytes: 1024 });
    expect(result).toMatchObject({ ok: false, code: "repo-too-large" });
    expect(existsSync(join(dir, "repo", "demo-repo"))).toBe(false);
  });

  it("fails a clone that errors, times out, or lacks the commit", async () => {
    expect(await cloneBare(base(work(), fakeGit({ fail: true }).git))).toMatchObject({
      ok: false,
      code: "job-failed",
      detail: "clone failed",
    });
    const started = Date.now();
    expect(
      await cloneBare({ ...base(work(), fakeGit({ sleep: 5 }).git), timeoutMs: 200 }),
    ).toMatchObject({ ok: false, code: "job-failed", detail: "clone timed out" });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await cloneBare({ ...base(work(), fakeGit().git), sha: "b".repeat(40) })).toMatchObject({
      ok: false,
      code: "job-failed",
      detail: "the commit is not in the clone",
    });
  });

  it("fails when git cannot be started", async () => {
    expect(await cloneBare({ ...base(work(), "/nonexistent/git") })).toMatchObject({
      ok: false,
      code: "job-failed",
    });
  });

  it("refuses a URL that is not a GitHub HTTPS clone URL", async () => {
    for (const url of [
      "file:///etc",
      "https://github.com/a/b.git/../c.git",
      "git@github.com:a/b.git",
    ]) {
      expect(await cloneBare({ ...base(work(), fakeGit().git), url })).toMatchObject({
        ok: false,
        code: "job-failed",
      });
    }
  });
});
