import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function resolveOutPath(repo: string, out: string): string | null {
  try {
    // Get absolute path of out
    const abs = resolve(out);

    // If out is a symlink, return null (refuse)
    try {
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        return null;
      }
    } catch (err) {
      // If lstat throws ENOENT on abs itself, that's fine, continue
      // Any other error is treated as fail-closed (refuse)
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "ENOENT") {
        return null;
      }
    }

    // Get the real path of the parent directory
    const parentDir = dirname(abs);
    const parentReal = realpathSync.native(parentDir);

    // Get the real path of the repo
    const repoReal = realpathSync.native(repo);

    // Construct the target path: canonical parent + basename
    const outName = basename(abs);
    const target = join(parentReal, outName);

    // Check if target is outside repo
    const rel = relative(repoReal, target);
    const isOutside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

    // Return target if outside, null if inside (to refuse writing)
    return isOutside ? target : null;
  } catch {
    // Any unexpected error - fail closed, refuse the write
    return null;
  }
}
