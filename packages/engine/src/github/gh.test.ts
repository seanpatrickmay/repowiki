import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GH_MAX_OUTPUT_BYTES, GH_TIMEOUT_MS, ghEnv, ghRunner, spawnGh } from "./gh.ts";

describe("ghEnv (R25)", () => {
  it("removes every ANTHROPIC_* variable and turns off prompts, the notifier and colour", () => {
    const env = ghEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_BASE_URL: "u" });
    expect(env).toEqual({
      PATH: "/bin",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    });
  });

  it("keeps what picks the owner's account and removes what redirects gh or git or leaks", () => {
    const env = ghEnv({
      PATH: "/bin",
      GH_TOKEN: "t1",
      GITHUB_TOKEN: "t2",
      GH_CONFIG_DIR: "/cfg",
      GH_HOST: "evil.example",
      GH_REPO: "evil/repo",
      GH_DEBUG: "api",
      GH_PAGER: "less",
      GH_BROWSER: "open",
      GH_ENTERPRISE_TOKEN: "t3",
      GITHUB_ENTERPRISE_TOKEN: "t4",
      GIT_DIR: "/elsewhere/.git",
      GIT_CONFIG_PARAMETERS: "'core.pager=evil'",
      GIT_SSH_COMMAND: "evil",
      GH_PROMPT_DISABLED: "0",
      NO_COLOR: "0",
    });
    expect(env).toEqual({
      PATH: "/bin",
      GH_TOKEN: "t1",
      GITHUB_TOKEN: "t2",
      GH_CONFIG_DIR: "/cfg",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    });
  });
});

describe("spawnGh", () => {
  let dir: string;
  let saved: { path: string | undefined; key: string | undefined };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "repowiki-gh-"));
    saved = { path: process.env.PATH, key: process.env.ANTHROPIC_API_KEY };
  });
  afterEach(() => {
    process.env.PATH = saved.path;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the gh on PATH with an argv, never a shell, and without the API key", () => {
    // A fake gh that prints its argv and whether it was handed the key.
    writeFileSync(
      join(dir, "gh"),
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY ?? null, prompt: process.env.GH_PROMPT_DISABLED }));\n`,
    );
    chmodSync(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}:${saved.path ?? ""}`;
    process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key";
    const out = spawnGh(["api", "-f", "owner=$(touch pwned); `id`"]);
    expect(out.failure).toBeNull();
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      args: ["api", "-f", "owner=$(touch pwned); `id`"],
      key: null,
      prompt: "1",
    });
  });

  it("says gh is missing when no gh is on PATH", () => {
    process.env.PATH = dir;
    expect(spawnGh(["--version"])).toMatchObject({ failure: "missing", status: null });
  });

  it("stops a gh that runs too long, and one whose answer is too large", () => {
    writeFileSync(
      join(dir, "gh"),
      '#!/bin/sh\ncase "$1" in slow) exec /bin/sleep 30;; esac\nhead -c 5000 /dev/zero\n',
    );
    chmodSync(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}:${saved.path ?? ""}`;
    const run = ghRunner({ timeoutMs: 300, maxBytes: 100 });
    expect(run(["slow"])).toMatchObject({ failure: "timeout", status: null });
    expect(run(["flood"])).toMatchObject({ failure: "overflow" });
    expect([GH_TIMEOUT_MS, GH_MAX_OUTPUT_BYTES]).toEqual([60_000, 32 * 1024 * 1024]);
  });
});
