import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scrubbedGitEnv } from "@repowiki/engine";

/** Canonical top level of the git work tree enclosing `repo`, or null when it is not in one. */
function workTreeTop(repo: string): string | null {
  try {
    const top = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: scrubbedGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return realpathSync.native(top);
  } catch {
    return null;
  }
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Canonical directory to keep wiki data in, or null to refuse: inside the documented repo or the
 * git work tree enclosing it (after resolving symlinks in the part that exists), the repo itself,
 * under a file, behind a dangling symlink, or unresolvable.
 */
export function resolveOutDir(repo: string, out: string): string | null {
  try {
    let existing = resolve(out);
    const missing: string[] = [];
    while (!existsSync(existing)) {
      // A dangling symlink exists to lstat but not to stat; mkdir would follow it.
      if (lstatSync(existing, { throwIfNoEntry: false }) !== undefined) return null;
      const parent = dirname(existing);
      if (parent === existing) return null;
      missing.unshift(basename(existing));
      existing = parent;
    }
    if (!statSync(existing).isDirectory()) return null;
    const target = join(realpathSync.native(existing), ...missing);
    const roots = [realpathSync.native(repo), workTreeTop(repo)];
    return roots.every((root) => root === null || isOutside(root, target)) ? target : null;
  } catch {
    return null;
  }
}
