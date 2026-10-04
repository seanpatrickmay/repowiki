import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
export function runCli(args: readonly string[], cwd?: string): CliResult {
  const tempCwd = cwd || mkdtempSync(join(tmpdir(), "repowiki-cli-"));
  const shouldCleanup = !cwd;
  try {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      timeout: 110_000,
      cwd: tempCwd,
      env: { ...process.env, NODE_ENV: "production" },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    if (shouldCleanup) rmSync(tempCwd, { recursive: true, force: true });
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
    // Regex: whitespace or start of string, then id="...", to avoid matching data-id
    for (const [, id = ""] of html.matchAll(/(?:^|\s)id="([^"]*)"/g)) {
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
          const frag = decodeURIComponent(link.slice(1));
          if (!pageIds.get(page)?.has(frag)) {
            broken.push(`${page} -> ${link}`);
          }
          checked++;
        }
        continue;
      }

      // Absolute URLs (http:// or https:// or //)
      if (link.startsWith("http://") || link.startsWith("https://") || link.startsWith("//")) {
        continue;
      }

      // Root-relative links (e.g., "/wiki/foo/" or "/wiki/foo/#bar")
      if (!link.startsWith("/")) continue;

      checked++;

      // Parse path and fragment
      const hashIndex = link.indexOf("#");
      const pathPart = hashIndex >= 0 ? link.slice(0, hashIndex) : link;
      const fragPart = hashIndex >= 0 ? link.slice(hashIndex + 1) : undefined;
      // Strip query string before decoding
      const pathWithoutQuery = pathPart.replace(/\?.*$/, "");
      const decodedPath = decodeURIComponent(pathWithoutQuery);
      const target = decodedPath.endsWith("/") ? `${decodedPath}index.html` : decodedPath;

      if (!existsSync(join(outDir, target))) {
        broken.push(`${page} -> ${link}`);
        continue;
      }

      // Check fragment if present
      if (fragPart) {
        const decodedFrag = decodeURIComponent(fragPart);
        const targetPage = target.replace(/^\//, "");
        if (!pageIds.get(targetPage)?.has(decodedFrag)) {
          broken.push(`${page} -> ${link}`);
        }
      }
    }
  }

  return { broken, checked };
}

const OFFSITE_URL = /^\s*(?:https?:)?\/\//i;
/** In a srcset, each comma-separated candidate starts with a URL. */
const OFFSITE_SRCSET = /(?:^|,)\s*(?:https?:)?\/\//i;
const OFFSITE_CSS = /(?:@import\s*|url\(\s*)["']?\s*(?:https?:)?\/\//gi;
const URL_ATTRIBUTES = new Set(["src", "srcset", "href", "poster", "data", "action", "xlink:href"]);
// A tag whose quoted attribute values may contain ">".
const TAG = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const STYLE_ELEMENT = /<style\b(?:"[^"]*"|'[^']*'|[^'">])*>([\s\S]*?)<\/style\s*>/gi;

/** Off-site `url(...)` and `@import` targets in CSS text, as the matched fragments. */
export function offsiteCssUrls(css: string): string[] {
  return [...css.matchAll(OFFSITE_CSS)].map((match) => match[0]);
}

/**
 * Resources an HTML page would load from another origin: URL-valued attributes on every tag
 * except `<a>` (outbound links are navigation, not loads), plus `url(...)` and `@import` in
 * `<style>` bodies and `style=` attributes. Returns one description per hit.
 */
export function offsiteResources(html: string): string[] {
  const found: string[] = [];
  for (const [, name = "", attributes = ""] of html.matchAll(TAG)) {
    const tag = name.toLowerCase();
    for (const [, rawName = "", doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(
      ATTRIBUTE,
    )) {
      const attribute = rawName.toLowerCase();
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
      if (attribute === "style") {
        for (const hit of offsiteCssUrls(value)) found.push(`<${tag} style> ${hit}`);
      } else if (tag !== "a" && URL_ATTRIBUTES.has(attribute)) {
        const pattern = attribute === "srcset" ? OFFSITE_SRCSET : OFFSITE_URL;
        if (pattern.test(value)) found.push(`<${tag} ${attribute}="${value}">`);
      }
    }
  }
  for (const [, body = ""] of html.matchAll(STYLE_ELEMENT)) {
    for (const hit of offsiteCssUrls(body)) found.push(`<style> ${hit}`);
  }
  return found;
}
