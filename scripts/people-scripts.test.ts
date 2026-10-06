import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listing } from "@repowiki/engine/test-inflight";
import { PEOPLE_SECRETS, type PeopleFixture, peopleFixture } from "@repowiki/engine/test-people";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test builds a fixture wiki and runs the command as a process: seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SUGGEST = fileURLToPath(new URL("./people-suggest.ts", import.meta.url));

let fx: PeopleFixture;
beforeEach(async () => {
  fx = await peopleFixture({ onDisk: true });
});
afterEach(() => fx.remove());

const run = (script: string, ...argv: string[]) =>
  spawnSync(process.execPath, [script, fx.repo.dir, "--out", fx.out, ...argv], {
    encoding: "utf8",
  });

describe("pnpm people:suggest (spec v2 #6 §6 step 6)", () => {
  it("prints the people with masked emails only, and writes neither the store nor the repo", () => {
    const db = readFileSync(join(fx.out, "wiki.db"));
    const repo = listing(fx.repo.dir);
    const result = run(SUGGEST);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("`ada…@example.com`");
    expect(result.stdout).toContain("`ada-lovelace`");
    for (const secret of PEOPLE_SECRETS)
      expect(result.stdout + result.stderr).not.toContain(secret);
    expect(readFileSync(join(fx.out, "wiki.db")).equals(db)).toBe(true);
    expect(listing(fx.repo.dir)).toEqual(repo);
  });

  it("refuses a people file inside the repository with exit 2", () => {
    const result = run(SUGGEST, "--people-file", join(fx.repo.dir, "people.json"));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/inside the documented repository/);
  });

  it("refuses an out dir with no wiki", () => {
    const result = spawnSync(
      process.execPath,
      [SUGGEST, fx.repo.dir, "--out", join(fx.out, "empty")],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/run pnpm wiki:build first/);
  });
});
