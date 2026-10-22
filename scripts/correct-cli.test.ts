import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, WikiExport } from "@repowiki/core";
import { INGEST_PY, makeManifest, makeRevision } from "@repowiki/core/test-fixtures";
import { createTestRepo, type TestRepo } from "@repowiki/engine/test-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORRECT_USAGE, parseCorrectArgs, readRequests } from "./correct-cli.ts";

// The command runs as a process over a fixture repository: seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CORRECT = fileURLToPath(new URL("./wiki-correct.ts", import.meta.url));
const NOTE = "a private note only the model may see";

let repo: TestRepo;
let dir: string;
beforeEach(() => {
  repo = createTestRepo();
  repo.write("src/signals/ingest.py", INGEST_PY);
  const head = repo.commit("signals: ingest chunks");
  dir = mkdtempSync(join(tmpdir(), "repowiki-correct-"));
  const page = makeRevision({ sha: head });
  const exp = WikiExport.parse({
    schemaVersion: SCHEMA_VERSION,
    repo: "demo",
    head,
    exportedAt: "2026-10-22T12:00:00.000Z",
    manifest: makeManifest({ sha: head }),
    pages: [page],
    history: { signals: [page] },
  });
  writeFileSync(join(dir, "export.json"), JSON.stringify(exp));
});
afterEach(() => {
  repo.remove();
  rmSync(dir, { recursive: true, force: true });
});

const requests = (items: unknown) => {
  const path = join(dir, "requests.json");
  writeFileSync(path, JSON.stringify(items));
  return path;
};
/** The command as a process with no API key: no test reaches the network. */
const run = (requestsPath: string, out = join(dir, "corrected.json"), at = repo.dir) =>
  spawnSync(
    process.execPath,
    [CORRECT, at, "--export", join(dir, "export.json"), "--requests", requestsPath, "--out", out],
    { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } },
  );

describe("wiki:correct's arguments", () => {
  it("takes the repository and the three files, and refuses anything else", () => {
    expect(
      parseCorrectArgs(["r", "--export", "e", "--requests", "q", "--out", "o", "--config", "c"]),
    ).toEqual({ repo: "r", exportPath: "e", requestsPath: "q", out: "o", config: "c" });
    expect(() => parseCorrectArgs(["r", "--export", "e", "--requests", "q"])).toThrow(
      CORRECT_USAGE,
    );
    expect(() =>
      parseCorrectArgs(["r", "s", "--export", "e", "--requests", "q", "--out", "o"]),
    ).toThrow(CORRECT_USAGE);
  });

  it("reads at most ten requests with short notes, and never echoes a refused file", () => {
    expect(readRequests(requests([{ page: "signals", claimId: "c-1", note: NOTE }]))).toEqual([
      { page: "signals", claimId: "c-1", note: NOTE },
    ]);
    const many = Array.from({ length: 11 }, () => ({
      page: "signals",
      claimId: "c-1",
      note: NOTE,
    }));
    expect(() => readRequests(requests(many))).toThrow(/at most 10/);
    const long = [{ page: "signals", claimId: "c-1", note: `${NOTE}${"x".repeat(600)}` }];
    let message = "";
    try {
      readRequests(requests(long));
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/500 characters/);
    expect(message).not.toContain(NOTE);
  });
});

describe("pnpm wiki:correct as a process", () => {
  it("writes the export and prints each refusal when no request needs a call", () => {
    const result = run(requests([{ page: "signals", claimId: "c99", note: NOTE }]));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      outcomes: [
        {
          page: "signals",
          claimId: "c99",
          outcome: "refused",
          detail: "the article has no such sentence",
        },
      ],
    });
    const corrected = WikiExport.parse(
      JSON.parse(readFileSync(join(dir, "corrected.json"), "utf8")),
    );
    expect(corrected.pages[0]?.id).toBe("rev-1");
    expect(result.stdout + result.stderr).not.toContain(NOTE);
  });

  it("fails without a key when a call is due, printing no note and writing nothing", () => {
    const result = run(requests([{ page: "signals", claimId: "c-1", note: NOTE }]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY");
    expect(result.stdout + result.stderr).not.toContain(NOTE);
    expect(existsSync(join(dir, "corrected.json"))).toBe(false);
  });

  it("corrects a bare clone, as the worker's is", () => {
    const bare = join(dir, "clone.git");
    spawnSync("git", ["clone", "-q", "--bare", repo.dir, bare]);
    const out = join(dir, "from-bare.json");
    const result = run(requests([{ page: "signals", claimId: "c99", note: NOTE }]), out, bare);
    expect(result.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(run(requests([]), join(bare, "inside.json"), bare).status).toBe(2);
  });

  it("refuses to write inside the repository it corrects", () => {
    const result = run(requests([]), join(repo.dir, "corrected.json"));
    expect(result.status).toBe(2);
    expect(existsSync(join(repo.dir, "corrected.json"))).toBe(false);
  });
});
