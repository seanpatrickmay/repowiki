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
export function runCli(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
  const exportFile = join(dir, "export.json");
  writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
  const outDir = join(dir, "site");
  const result = runCli(["build", "--export", exportFile, "--out", outDir, ...extraArgs]);
  if (result.status !== 0) throw new Error(`site build failed:\n${result.stderr}${result.stdout}`);
  return {
    dir,
    outDir,
    stdout: result.stdout,
    read: (path) => readFileSync(join(outDir, path), "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Every built HTML file, relative to outDir, sorted. */
export function htmlFiles(outDir: string): string[] {
  return (readdirSync(outDir, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".html"))
    .map((file) => file.split("\\").join("/"))
    .sort();
}

/**
 * Same-site links that point nowhere: root-relative href/src values whose target file is
 * missing, and "#fragment" links whose id is not on the page. Returns "page -> link" strings.
 */
export function brokenLinks(outDir: string): string[] {
  const broken: string[] = [];
  for (const page of htmlFiles(outDir)) {
    const html = readFileSync(join(outDir, page), "utf8");
    for (const [, link = ""] of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      if (link.startsWith("#")) {
        if (link.length > 1 && !html.includes(`id="${link.slice(1)}"`)) {
          broken.push(`${page} -> ${link}`);
        }
        continue;
      }
      if (!link.startsWith("/") || link.startsWith("//")) continue;
      const path = decodeURIComponent(link.replace(/[?#].*$/, ""));
      const target = path.endsWith("/") ? `${path}index.html` : path;
      if (!existsSync(join(outDir, target))) broken.push(`${page} -> ${link}`);
    }
  }
  return broken;
}
