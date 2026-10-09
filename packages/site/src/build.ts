import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WikiExport } from "@repowiki/core";
import type { AstroInlineConfig } from "astro";
import { build, preview } from "astro";
import { UsageError } from "./args.ts";
import { loadExport } from "./load.ts";
import { writeSearchIndex } from "./search-index.ts";
import { siteMarker } from "./site-format.ts";
import { writeSiteRoot } from "./site-root.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Validate that the output directory is safe and won't destroy user data. */
function validateOutDir(exportFile: string, outDir: string): void {
  const exportRealpath = realpathSync(exportFile);
  const cwdRealpath = realpathSync(process.cwd());

  // For non-existent out dirs, realpath the nearest existing ancestor
  let outRealpath: string;
  if (existsSync(outDir)) {
    outRealpath = realpathSync(outDir);
  } else {
    // Find the nearest existing ancestor
    let parent = outDir;
    while (!existsSync(parent)) {
      parent = dirname(parent);
    }
    const ancestor = realpathSync(parent);
    const suffix = outDir.slice(parent.length);
    outRealpath = ancestor + suffix;
  }

  // (a) out dir cannot contain the export file
  if (exportRealpath.startsWith(outRealpath + "/") || exportRealpath === outRealpath) {
    throw new UsageError(
      `--out cannot contain the export file. out=${outDir}, export=${exportFile}`,
    );
  }

  // (b) out dir cannot contain .git (only if it exists)
  if (existsSync(outRealpath) && existsSync(`${outRealpath}/.git`)) {
    throw new UsageError(`--out cannot be or contain a git repository (found .git in ${outDir})`);
  }

  // (c) out dir cannot be cwd or an ancestor of cwd
  if (cwdRealpath === outRealpath || cwdRealpath.startsWith(outRealpath + "/")) {
    throw new UsageError(
      `--out cannot be the current directory or a parent of it (cwd=${cwdRealpath}, out=${outDir})`,
    );
  }

  // (d) out dir must be empty or have the marker file
  if (existsSync(outRealpath)) {
    const files = readdirSync(outRealpath);
    const hasMarker = files.includes(".repowiki-site");
    if (files.length > 0 && !hasMarker) {
      throw new UsageError(
        `--out must be empty or a previous RepoWiki build (no .repowiki-site marker in ${outDir})`,
      );
    }
  }
}

/**
 * Environment the Astro pages read (see site.ts). Telemetry is off: builds never touch the network.
 * REPOWIKI_BUILD is new on every call, so a second build in the same process loads its own export.
 */
function setBuildEnv(exportFile: string, repoUrl: string | null): void {
  process.env.ASTRO_TELEMETRY_DISABLED = "1";
  process.env.REPOWIKI_BUILD = randomUUID();
  process.env.REPOWIKI_EXPORT = exportFile;
  process.env.REPOWIKI_REPO_URL = repoUrl ?? "";
}

function astroConfig(outDir: string): AstroInlineConfig {
  return {
    root: ROOT,
    outDir,
    configFile: false,
    logLevel: "warn",
    compressHTML: false,
    trailingSlash: "always",
    build: { format: "directory", inlineStylesheets: "never" },
    devToolbar: { enabled: false },
    server: { host: "127.0.0.1", port: 4321 },
    // Emit every script as a file, so pages (and their snapshots) only reference hashed assets.
    // Mermaid's ELK layout chunk is ~1.46 MB and only loads for a diagram that needs it, so the
    // default 500 kB chunk warning is noise; 2000 kB still warns if a chunk grows past that.
    vite: { build: { assetsInlineLimit: 0, chunkSizeWarningLimit: 2000 } },
  };
}

export interface BuildResult {
  /** HTML files Pagefind read; only pages marked data-pagefind-body become search results. */
  htmlPages: number;
}

/**
 * Validates the export, renders the static site into outDir, puts the wiki's llms.txt and the
 * export it lists at the site's root (F07), indexes the site with Pagefind, and last writes the
 * marker with the site code's format (siteMarker, taken when the build starts).
 */
export async function buildSite(
  exportFile: string,
  outDir: string,
  repoUrl: string | null,
  options: { inflight?: boolean } = {},
): Promise<BuildResult> {
  const loaded = loadExport(exportFile);
  validateOutDir(exportFile, outDir);
  // Without the work in flight, the pages are built from, and the root's export is, a copy of
  // the export with `inflight: null`: no private pull request title leaves in a shared site (R18).
  const wiki = options.inflight === false ? { ...loaded, inflight: null } : loaded;
  const scratch = options.inflight === false ? mkdtempSync(join(tmpdir(), "repowiki-site-")) : null;
  const pages = scratch === null ? exportFile : join(scratch, "export.json");
  try {
    // Inside the try, so a failed write (a full disk) still removes the scratch directory.
    if (scratch !== null) writeFileSync(pages, `${JSON.stringify(wiki)}\n`);
    return await render(pages, outDir, repoUrl, wiki);
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Renders the site from `exportFile`, writes its root files from `wiki`, and indexes it. */
async function render(
  exportFile: string,
  outDir: string,
  repoUrl: string | null,
  wiki: WikiExport,
): Promise<BuildResult> {
  setBuildEnv(exportFile, repoUrl);
  const marker = siteMarker();

  // Astro puts a static build's server chunks in <cwd>/.astro/ when the out dir is outside the
  // cwd, so each build gets its own cwd under packages/site/.astro (where the chunks still find
  // packages/site's node_modules): builds that shared one cwd raced on .astro/.prerender, and
  // the caller's cwd stays clean.
  const previousCwd = process.cwd();
  mkdirSync(join(ROOT, ".astro"), { recursive: true });
  const buildCwd = mkdtempSync(join(ROOT, ".astro", "build-"));
  try {
    process.chdir(buildCwd);
    await build(astroConfig(outDir));
  } finally {
    process.chdir(previousCwd);
    rmSync(buildCwd, { recursive: true, force: true });
  }

  // An empty marker allows a rebuild; only a finished build's marker names its format, so a
  // build cut short (a half-written Pagefind index) is not current for wiki:serve.
  writeFileSync(`${outDir}/.repowiki-site`, "");
  writeSiteRoot(outDir, wiki);
  const result = await writeSearchIndex(outDir);
  writeFileSync(`${outDir}/.repowiki-site`, marker);
  return result;
}

/** Serves a built site on http://127.0.0.1:4321/ until the process is stopped. */
export async function previewSite(outDir: string): Promise<void> {
  if (!existsSync(`${outDir}/.repowiki-site`)) {
    throw new UsageError(
      `no built site in ${outDir}; run \`pnpm site:build --export <file>\` first`,
    );
  }
  process.env.ASTRO_TELEMETRY_DISABLED = "1";
  const previousCwd = process.cwd();
  try {
    process.chdir(ROOT);
    await preview(astroConfig(outDir));
  } finally {
    process.chdir(previousCwd);
  }
}
