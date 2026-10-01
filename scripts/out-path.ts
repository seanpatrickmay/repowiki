import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Canonical top level of the work tree enclosing `repo`, the tree `git -C repo` indexes. */
function repoTopLevel(repo: string): string {
  const top = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return realpathSync.native(top);
}

/** Canonical path to write `out` to, or null to refuse (inside the enclosing git work tree, symlink, directory, not a work tree, error). */
export function resolveOutPath(repo: string, out: string): string | null {
  try {
    const abs = resolve(out);

    try {
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink() || stat.isDirectory()) return null;
    } catch (err) {
      // ENOENT is fine: the file does not exist yet.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }

    // Canonical parent plus the typed basename: the final segment is never followed or normalized.
    const target = join(realpathSync.native(dirname(abs)), basename(abs));

    const rel = relative(repoTopLevel(repo), target);
    const isOutside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    return isOutside ? target : null;
  } catch {
    return null;
  }
}
