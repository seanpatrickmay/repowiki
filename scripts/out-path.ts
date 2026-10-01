import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export function isInsideRepo(repo: string, out: string): boolean {
  try {
    // Get absolute path of out
    const abs = resolve(out);

    // If out is a symlink, treat as unsafe and refuse (return true - fail closed)
    try {
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        return true;
      }
    } catch (err) {
      // If lstat throws ENOENT on abs itself, that's fine, continue
      // Any other error is treated as fail-closed
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "ENOENT") {
        return true;
      }
    }

    // Get the real path of the parent directory (must exist)
    const parentDir = dirname(abs);
    const parentReal = realpathSync.native(parentDir);

    // Get the real path of the repo (will throw if it doesn't exist - fail closed)
    const repoReal = realpathSync.native(repo);

    // Construct the real out path by joining the real parent with the basename
    const outName = basename(abs);
    const outReal = join(parentReal, outName);

    // Check if out is inside repo
    const rel = relative(repoReal, outReal);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    // Any unexpected error - fail closed, refuse the write
    return true;
  }
}
