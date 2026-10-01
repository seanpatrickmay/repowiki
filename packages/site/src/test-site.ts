import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureExport } from "./test-fixtures.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the site CLI in a child process, as `pnpm site:build` does. */
export function runCli(args: readonly string[]): CliResult {
  const cwd = mkdtempSync(join(tmpdir(), "repowiki-cli-"));
  try {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      timeout: 110_000,
      cwd,
      env: { ...process.env, NODE_ENV: "production" },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export interface BuiltSite {
  dir: string;
  outDir: string;
  stdout: string;
  /** Contents of a built file, by its path relative to the output directory. */
  read(path: string): string;
  cleanup(): void;
}

/** Writes the fixture export to a temp dir and builds the site from it. */
export function buildFixtureSite(extraArgs: readonly string[] = []): BuiltSite {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-site-"));
  try {
    const exportFile = join(dir, "export.json");
    writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
    const outDir = join(dir, "site");
    mkdirSync(outDir, { recursive: true });
    const result = runCli(["build", "--export", exportFile, "--out", outDir, ...extraArgs]);
    if (result.status !== 0)
      throw new Error(`site build failed:\n${result.stderr}${result.stdout}`);
    return {
      dir,
      outDir,
      stdout: result.stdout,
      read: (path) => readFileSync(join(outDir, path), "utf8"),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Every built HTML file, relative to outDir, sorted. */
export function htmlFiles(outDir: string): string[] {
  return (readdirSync(outDir, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".html"))
    .map((file) => file.split("\\").join("/"))
    .sort();
}

export interface BrokenLinksResult {
  broken: string[];
  checked: number;
}

/**
 * Same-site links that point nowhere: root-relative href/src values whose target file is
 * missing, and "#fragment" links whose id is not on the target page. Returns { broken, checked }
 * where broken is ["page -> link", ...] and checked is the count of links validated.
 */
export function brokenLinks(outDir: string): BrokenLinksResult {
  const pages = htmlFiles(outDir);
  if (pages.length === 0) throw new Error("site has no HTML files");

  // Build a map of page paths to their ids
  const pageIds = new Map<string, Set<string>>();
  for (const page of pages) {
    const html = readFileSync(join(outDir, page), "utf8");
    const ids = new Set<string>();
    for (const [, id = ""] of html.matchAll(/id="([^"]*)"/g)) {
      ids.add(id);
    }
    pageIds.set(page, ids);
  }

  const broken: string[] = [];
  let checked = 0;

  for (const page of pages) {
    const html = readFileSync(join(outDir, page), "utf8");
    for (const [, link = ""] of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      // Fragment-only links (e.g., "#section")
      if (link.startsWith("#")) {
        if (link.length > 1) {
          const frag = link.slice(1);
          if (!pageIds.get(page)?.has(frag)) {
            broken.push(`${page} -> ${link}`);
          }
          checked++;
        }
        continue;
      }

      // Absolute URLs (http:// or https:// or //)
      if (link.startsWith("http://") || link.startsWith("https://") || link.startsWith("//")) {
        checked++;
        continue;
      }

      // Root-relative links (e.g., "/wiki/foo/" or "/wiki/foo/#bar")
      if (!link.startsWith("/")) continue;

      checked++;

      // Parse path and fragment
      const hashIndex = link.indexOf("#");
      const pathPart = hashIndex >= 0 ? link.slice(0, hashIndex) : link;
      const fragPart = hashIndex >= 0 ? link.slice(hashIndex + 1) : undefined;
      const decodedPath = decodeURIComponent(pathPart);
      const target = decodedPath.endsWith("/") ? `${decodedPath}index.html` : decodedPath;

      if (!existsSync(join(outDir, target))) {
        broken.push(`${page} -> ${link}`);
        continue;
      }

      // Check fragment if present
      if (fragPart) {
        const targetPage = target.replace(/^\//, "");
        if (!pageIds.get(targetPage)?.has(fragPart)) {
          broken.push(`${page} -> ${link}`);
        }
      }
    }
  }

  return { broken, checked };
}
