import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** packages/site, whose source and package.json make a build what it is. */
const SITE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** packages/core, whose sources the site bundles (claimAnchor, renderLlmsTxt and more). */
const CORE_ROOT = fileURLToPath(new URL("../../core", import.meta.url));

/** Files only tests read: changing them changes no built page. */
const testOnly = (path: string) =>
  /\.test\.ts$/.test(path) || path.split("/").includes("__snapshots__");

/** A package's package.json and its non-test files under src, by relative path, sorted. */
function packageFiles(root: string): string[] {
  const files = readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => !testOnly(path));
  return ["package.json", ...files.sort()];
}

/**
 * The site code's format (spec v2 #4 R16, M9 final review I2): a SHA-256 over the paths and bytes
 * of `package.json` and every file under `src` but the tests, in path order, of packages/site and
 * of the @repowiki/core it bundles. A site built by other site or core code (an upgrade, M9's
 * claim anchors) has another format, so the marker tells a current build from a stale one.
 */
export function siteFormat(root = SITE_ROOT, core = CORE_ROOT): string {
  const hash = createHash("sha256");
  for (const [name, dir] of [
    ["site", root],
    ["core", core],
  ] as const) {
    for (const path of packageFiles(dir)) {
      hash.update(`${name}/${path}\0`);
      hash.update(readFileSync(join(dir, path)));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

/** The marker a finished build leaves in its out dir: the format it was built with. */
export const siteMarker = (format: string = siteFormat()): string =>
  `${JSON.stringify({ format })}\n`;
