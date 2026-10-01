import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

export function isInsideRepo(repo: string, out: string): boolean {
  // Canonicalize the repo path (resolves symlinks, case variants)
  const repoReal = realpathSync.native(repo);

  // Canonicalize the out path
  // If out doesn't exist, walk up to the deepest existing ancestor
  let outReal = out;
  let current = out;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      // Reached the root without finding an existing path
      break;
    }
    current = parent;
  }

  if (existsSync(current)) {
    // We found an existing ancestor, canonicalize it
    const realAncestor = realpathSync.native(current);
    const remaining = out.slice(current.length);
    outReal = realAncestor + remaining;
  }

  // Check if out is the same as repo or inside repo
  const rel = relative(repoReal, outReal);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
