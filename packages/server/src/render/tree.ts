import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** One file of a site tree: its posix path inside the tree and its bytes. */
export interface TreeFile {
  path: string;
  bytes: Uint8Array;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** SHA-256 over every file's path and SHA-256, sorted by path (spec 2 S13). */
export function treeHash(files: readonly TreeFile[]): string {
  const lines = files.map((f) => `${f.path}\0${sha256(f.bytes)}\n`).sort(byPath);
  return sha256(lines.join(""));
}

/** Every file under `dir` as `prefix` + its posix path, sorted; the site's build marker is left out. */
export function readTree(dir: string, prefix = ""): TreeFile[] {
  const files: TreeFile[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === ".repowiki-site") continue;
    const full = join(entry.parentPath, entry.name);
    const path = `${prefix}${relative(dir, full).split(sep).join("/")}`;
    files.push({ path, bytes: readFileSync(full) });
  }
  return files.sort((a, b) => byPath(a.path, b.path));
}
