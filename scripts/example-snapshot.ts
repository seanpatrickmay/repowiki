import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTree,
  exampleSnapshot,
  loadConfig,
  objectStoreFor,
  openDatabase,
} from "@repowiki/server";
import { resolveOutDir } from "./out-dir.ts";

const USAGE = "usage: pnpm example:snapshot <data-dir> <handle> --out <dir>";

/**
 * pnpm example:snapshot (ADR-0017): the example's snapshot from a stopped local mode server's data
 * directory, written to `--out` (outside this repository) for `pnpm example:upload`.
 */
async function main(): Promise<void> {
  const [dataDir, handle, flag, out] = process.argv.slice(2);
  if (dataDir === undefined || handle === undefined || flag !== "--out" || out === undefined) {
    throw new Error(USAGE);
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const target = resolveOutDir(repoRoot, out);
  if (target === null) throw new Error(`refusing to write the snapshot to ${out}`);
  const config = loadConfig({ REPOWIKI_MODE: "development", DATA_DIR: resolve(dataDir) });
  const db = await openDatabase(config.database);
  try {
    const files = await exampleSnapshot({
      db,
      objects: objectStoreFor(config.objects, fetch),
      handle,
      now: () => new Date().toISOString(),
      build: buildTree,
    });
    rmSync(target, { recursive: true, force: true });
    for (const file of files) {
      mkdirSync(dirname(join(target, file.path)), { recursive: true });
      writeFileSync(join(target, file.path), file.bytes);
    }
    console.log(`wrote ${files.length} files to ${target}`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
