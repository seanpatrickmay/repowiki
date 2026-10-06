import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** packages/site, whose source and package.json make a build what it is. */
const SITE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Files only tests read: changing them changes no built page. */
const testOnly = (path: string) =>
  /\.test\.ts$/.test(path) || path.split("/").includes("__snapshots__");

/**
 * The site code's format (spec v2 #4 R16, M9 final review I2): a SHA-256 over the paths and bytes
 * of `<root>/package.json` and every file under `<root>/src` but the tests, in path order. A site
 * built by other site code (an upgrade, M9's sidebar and claim anchors, a later header) has
 * another format, so wiki:serve rebuilds it instead of serving it as current.
 */
export function siteFormat(root = SITE_ROOT): string {
  const files = readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => !testOnly(path));
  const hash = createHash("sha256");
  for (const path of ["package.json", ...files.sort()]) {
    hash.update(`${path}\0`);
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The marker a finished build leaves in its out dir: the format it was built with. */
export const siteMarker = (format: string = siteFormat()): string =>
  `${JSON.stringify({ format })}\n`;
