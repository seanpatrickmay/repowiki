import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localRunner } from "./local-runner.ts";

const request = { jobId: "job-1", attempt: 1, token: "t".repeat(43) };

/** A worker entry that records its HOME, then exits. */
function recordingEntry(): { entry: string; homeFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-runner-test-"));
  const homeFile = join(dir, "home.txt");
  const entry = join(dir, "worker.mjs");
  writeFileSync(
    entry,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(homeFile)}, process.env.HOME);\n`,
  );
  return { entry, homeFile };
}

describe("localRunner (spec 2 S16)", () => {
  it("resolves once the child spawned and removes its temporary home when it exits", async () => {
    const { entry, homeFile } = recordingEntry();
    let exited: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const lines: object[] = [];
    const runner = localRunner({
      workerEntry: entry,
      internalUrl: "http://127.0.0.1:1",
      mode: "fixture",
      log: (line) => {
        lines.push(line);
        if ("exit" in line) exited();
      },
    });
    await runner.start(request);
    await exit;
    const home = readFileSync(homeFile, "utf8");
    expect(home).toContain("repowiki-worker-");
    expect(existsSync(home)).toBe(false);
    expect(lines).toEqual([{ worker: "job-1", attempt: 1, exit: 0 }]);
  });

  it("passes the profile in import mode only (M14g)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-runner-test-"));
    const envFile = join(dir, "env.json");
    const entry = join(dir, "worker.mjs");
    writeFileSync(
      entry,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));\n`,
    );
    const run = async (mode: "fixture" | "import") => {
      let exited: () => void = () => undefined;
      const exit = new Promise<void>((resolve) => {
        exited = resolve;
      });
      const runner = localRunner({
        workerEntry: entry,
        internalUrl: "http://127.0.0.1:1",
        mode,
        profile: "/profiles/ada.json",
        log: (line) => ("exit" in line ? exited() : undefined),
      });
      await runner.start(request);
      await exit;
      return JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
    };
    expect(await run("import")).toMatchObject({
      REPOWIKI_WORKER_MODE: "import",
      REPOWIKI_PROFILE: "/profiles/ada.json",
    });
    expect((await run("fixture")).REPOWIKI_PROFILE).toBeUndefined();
  });

  it("rejects when the child cannot be spawned", async () => {
    const runner = localRunner({
      workerEntry: "worker.mjs",
      internalUrl: "http://127.0.0.1:1",
      mode: "fixture",
      log: () => undefined,
      execPath: join(tmpdir(), "no-such-node-binary"),
    });
    await expect(runner.start(request)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
