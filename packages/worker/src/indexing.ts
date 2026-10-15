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
  run?: typeof runCli;
}): Promise<{ files: FileFacts[] }> {
  const run = await (input.run ?? runCli)({
    script: INDEX_CHILD,
    args: [input.repo, input.sha],
    env: gitEnv(input.home),
    timeoutMs: input.timeoutMs ?? INDEX_TIMEOUT_MS,
    nodeArgs: [`--max-old-space-size=${INDEX_HEAP_MB}`],
    stdoutBytes: INDEX_STDOUT_BYTES,
  });
  if (run.status !== 0 || typeof run.stdout !== "string") {
    throw new Error(`the index ${run.timedOut ? "timed out" : `exited ${run.status}`}`);
  }
  return { files: IndexFacts.parse(JSON.parse(run.stdout)).files };
}
