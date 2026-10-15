import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { gitEnv } from "./clone.ts";
import { runCli } from "./engine.ts";
import type { FileFacts } from "./facts.ts";

export const INDEX_CHILD = fileURLToPath(new URL("./index-child.ts", import.meta.url));
/** The index child's limits: 15 minutes and a 2 GiB heap (spec 2 S9). */
export const INDEX_TIMEOUT_MS = 15 * 60_000;
export const INDEX_HEAP_MB = 2048;
/** The most the child may print: far more than the facts of any tree under the file limit. */
const INDEX_STDOUT_BYTES = 64 * 1024 * 1024;
export const COUNT_TIMEOUT_MS = 2 * 60_000;
/**
 * The tree may list this many times the plan's file limit before the worker refuses it unindexed
 * (the fast-fail ruling): the limit counts indexed files, and a tree's binaries and oversized
 * files are listed but not indexed, so only a tree well past the limit is refused on its listing.
 */
export const TREE_FACTOR = 3;

const IndexFacts = z.object({
  indexed: z.int().nonnegative(),
  files: z.array(
    z.object({
      language: z.string().nullable(),
      loc: z.int().nonnegative(),
      skipped: z.string().nullable(),
    }),
  ),
});

/** Indexes `sha` in a child (index-child.ts) under the time and heap limits; throws on any failure. */
export async function indexInChild(input: {
  repo: string;
  sha: string;
  home: string;
  timeoutMs?: number;
  /** Aborting it kills the child's process group. */
  signal?: AbortSignal;
  run?: typeof runCli;
}): Promise<{ files: FileFacts[] }> {
  const run = await (input.run ?? runCli)({
    script: INDEX_CHILD,
    args: [input.repo, input.sha],
    env: gitEnv(input.home),
    timeoutMs: input.timeoutMs ?? INDEX_TIMEOUT_MS,
    nodeArgs: [`--max-old-space-size=${INDEX_HEAP_MB}`],
    stdoutBytes: INDEX_STDOUT_BYTES,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (run.status !== 0 || typeof run.stdout !== "string") {
    throw new Error(`the index ${run.timedOut ? "timed out" : `exited ${run.status}`}`);
  }
  return { files: IndexFacts.parse(JSON.parse(run.stdout)).files };
}

/**
 * How many blobs the tree at `sha` lists (`git ls-tree -r --name-only -z`, counted as it streams,
 * never held), with gitEnv(home), in its own process group; null when git fails or passes
 * `timeoutMs`, after the group is killed.
 */
export function countTree(
  repo: string,
  sha: string,
  home: string,
  options: { git?: string; timeoutMs?: number } = {},
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      options.git ?? "git",
      ["-C", repo, "ls-tree", "-r", "--name-only", "-z", sha],
      { env: gitEnv(home), stdio: ["ignore", "pipe", "ignore"], detached: true },
    );
    let count = 0;
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const byte of chunk) if (byte === 0) count++;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs ?? COUNT_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve(status === 0 && !timedOut ? count : null);
    });
  });
}
