import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WikiExport } from "@repowiki/core";
import { readTree, type TreeFile, treeHash } from "./tree.ts";

export const SITE_BUILD_TIMEOUT_MS = 5 * 60_000;
const CHILD = fileURLToPath(new URL("./site-child.ts", import.meta.url));

let queue: Promise<unknown> = Promise.resolve();

/** Runs `job` after every job queued before it, one at a time in this process (spec 2 S13). */
export function renderQueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

/** The site child with a minimal environment, killed past SITE_BUILD_TIMEOUT_MS. */
function runChild(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? tmpdir() },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), SITE_BUILD_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `site build failed (${signal ?? code}): ${stderr.trim().split("\n").at(-1) ?? ""}`,
          ),
        );
    });
  });
}

/** The tree of a preview or version: the built wiki under docs/, plus portfolio.json (S13). */
export function buildTree(input: {
  exp: WikiExport;
  base: string;
  repoUrl: string;
  portfolio: Uint8Array;
}): Promise<{ files: TreeFile[]; hash: string }> {
  return renderQueue(async () => {
    const work = mkdtempSync(join(tmpdir(), "repowiki-render-"));
    try {
      const exportFile = join(work, "export.json");
      const outDir = join(work, "site");
      writeFileSync(exportFile, JSON.stringify(input.exp));
      await runChild([exportFile, outDir, input.repoUrl, input.base]);
      const files = [
        ...readTree(outDir, "docs/"),
        { path: "portfolio.json", bytes: input.portfolio },
      ];
      return { files, hash: treeHash(files) };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}
