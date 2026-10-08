import { createHash } from "node:crypto";
import { posix } from "node:path";
import { RepoPath } from "@repowiki/core";
import {
  type BlameRun,
  BlameSkippedError,
  blameFile,
  DEFAULT_MAX_FILE_BYTES,
  GitTimeoutError,
  isSha,
  listBlobs,
  streamBlobs,
} from "../index/index.ts";
import type { Store } from "../store/index.ts";

/** Lockfiles (spec v2 #6 R20): generated, so neither blamed nor counted in lines. */
export const LOCKFILES: ReadonlySet<string> = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "poetry.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
]);

export const isLockfile = (path: string): boolean => LOCKFILES.has(posix.basename(path));

/** The most `.git-blame-ignore-revs` entries honoured (R4). */
export const MAX_IGNORE_REVS = 1000;

/**
 * The commits a committed `.git-blame-ignore-revs` lists (R4): each line a full 40-hex sha of a
 * commit in `known` (git refuses one it cannot find), first MAX_IGNORE_REVS, in order; comments,
 * short shas and anything else are skipped.
 */
export function ignoreRevsFrom(text: string, known: ReadonlySet<string>): string[] {
  const revs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rev = line.trim().toLowerCase();
    if (isSha(rev) && known.has(rev) && !revs.includes(rev)) revs.push(rev);
    if (revs.length === MAX_IGNORE_REVS) break;
  }
  return revs;
}

/** Who wrote the head's lines (spec v2 #6 R1): blame runs per file, and what was left out. */
export interface Ownership {
  /** Each blamed text file's runs, by path, in path order. */
  files: Map<string, BlameRun[]>;
  /** Lines of files whose blame timed out: unattributed (spec v2 #6 §4 step 4). */
  timedOut: { path: string; lines: number }[];
  /**
   * Lines of files whose blame could not run for a cause outside the file (BlameSkippedError: a
   * configured ignore file git cannot read, output past the cap): unattributed, with the cause.
   */
  unattributed: { path: string; lines: number; cause: string }[];
  /** Files left out: lockfiles, binaries and files over the size limit (R20). */
  skipped: number;
  /** Files blamed this run, and files whose blame came from the cache (R3). */
  blamed: number;
  cached: number;
}

export interface BlameTreeOptions {
  /** Full shas to pass as --ignore-rev (ignoreRevsFrom). */
  ignoreRevs: readonly string[];
  /** Blames run at once (default 4). */
  concurrency?: number;
  /** Per file (default BLAME_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Files larger are not blamed (default DEFAULT_MAX_FILE_BYTES). */
  maxFileBytes?: number;
  /** wiki:people --rebuild-blame: forget the cache first. */
  rebuild?: boolean;
  /** listBlobs' and streamBlobs' time limit (no limit when absent). */
  readTimeoutMs?: number;
  /** The blame to run (default blameFile); tests replace it. */
  blame?: typeof blameFile;
}

/** The fingerprint of an ignore list: a cached blame holds only under the same list. */
const fingerprint = (revs: readonly string[]): string =>
  createHash("sha256")
    .update([...revs].sort().join("\n"))
    .digest("hex");

/**
 * Blames every text file at `sha` (spec v2 #6 R1-R4), from the store's cache where its
 * (path, blob) is there: an unchanged blob has an unchanged blame. Lockfiles, files over the size
 * limit and binaries are skipped; the rest is blamed `concurrency` at a time, each under its
 * timeout (a file that times out, or whose blame cannot run for a cause outside it, is reported,
 * its lines unattributed and nothing cached for it). Results are folded in path
 * order, so the answer does not depend on which blame finished first. The cache is pruned to the
 * head's (path, blob) pairs, and cleared when the ignore list changed or `rebuild` says so.
 */
export async function blameTree(
  repo: string,
  sha: string,
  store: Store,
  options: BlameTreeOptions,
): Promise<Ownership> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new RangeError(
      `blame concurrency must be a whole number of at least 1, not ${concurrency}`,
    );
  const blame = options.blame ?? blameFile;
  const ignore = fingerprint(options.ignoreRevs);
  if (options.rebuild === true || store.getPeopleMeta("blame-ignore") !== ignore) {
    store.clearBlameCache();
    store.setPeopleMeta("blame-ignore", ignore);
  }
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const read = options.readTimeoutMs === undefined ? {} : { timeoutMs: options.readTimeoutMs };
  const blobs = listBlobs(repo, sha, read);
  // A path RepoPath refuses (a backslash, say) is left out, as the indexer leaves it out.
  const wanted = blobs.filter(
    (b) => RepoPath.safeParse(b.path).success && !isLockfile(b.path) && b.size <= maxBytes,
  );
  let skipped = blobs.length - wanted.length;
  const files = new Map<string, BlameRun[]>();
  const todo: { path: string; oid: string }[] = [];
  let cached = 0;
  for (const blob of wanted) {
    const hit = store.getBlameRuns(blob.path, blob.oid);
    if (hit === null) todo.push(blob);
    else {
      files.set(blob.path, hit);
      cached++;
    }
  }
  // Binary blobs are sniffed as text is elsewhere (a NUL in the first 8,000 bytes).
  const oids = [...new Set(todo.map((b) => b.oid))];
  const sniffed = new Map<string, { binary: boolean; lines: number }>();
  // Keyed by each streamed blob's own oid, not its place (the Task 12 review's minor).
  for await (const data of streamBlobs(repo, oids, 0, read)) {
    sniffed.set(data.oid, { binary: data.head.includes(0), lines: data.lines });
  }
  const text = todo.filter((b) => sniffed.get(b.oid)?.binary !== true);
  skipped += todo.length - text.length;
  const results = new Map<string, BlameRun[] | "timeout" | { cause: string }>();
  let cursor = 0;
  // The first failure that is not a timeout or a skip stops every worker: no blame runs on in
  // the background after blameTree has failed.
  let failed = false;
  const worker = async () => {
    while (!failed && cursor < text.length) {
      const blob = text[cursor++] as { path: string; oid: string };
      try {
        const runs = await blame(repo, sha, blob.path, options.ignoreRevs, {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        results.set(blob.path, runs);
      } catch (error) {
        if (error instanceof GitTimeoutError) results.set(blob.path, "timeout");
        else if (error instanceof BlameSkippedError)
          results.set(blob.path, { cause: error.message });
        else {
          failed = true;
          throw error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const timedOut: Ownership["timedOut"] = [];
  const unattributed: Ownership["unattributed"] = [];
  for (const blob of text) {
    const result = results.get(blob.path);
    if (result === undefined) continue;
    const lines = sniffed.get(blob.oid)?.lines ?? 0;
    if (result === "timeout") {
      timedOut.push({ path: blob.path, lines });
      continue;
    }
    if (!Array.isArray(result)) {
      unattributed.push({ path: blob.path, lines, cause: result.cause });
      continue;
    }
    store.putBlameRuns(blob.path, blob.oid, result);
    files.set(blob.path, result);
  }
  store.pruneBlameCache(wanted.map(({ path, oid }) => ({ path, oid })));
  const sorted = new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const blamed = text.length - timedOut.length - unattributed.length;
  return { files: sorted, timedOut, unattributed, skipped, blamed, cached };
}
