import { existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AstroInlineConfig } from "astro";
import { build, preview } from "astro";
import * as pagefind from "pagefind";
import { UsageError } from "./args.ts";
import { loadExport } from "./load.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Validate that the output directory is safe and won't destroy user data. */
function validateOutDir(exportFile: string, outDir: string): void {
  const exportRealpath = realpathSync(exportFile);
  const outRealpath = realpathSync(outDir);
  const cwdRealpath = realpathSync(process.cwd());

  // (a) out dir cannot contain the export file
  if (exportRealpath.startsWith(outRealpath + "/") || exportRealpath === outRealpath) {
    throw new UsageError(
      `--out cannot contain the export file. out=${outDir}, export=${exportFile}`,
    );
  }

  // (b) out dir cannot contain .git
  if (existsSync(`${outRealpath}/.git`)) {
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

/** Environment the Astro pages read (see site.ts). Telemetry is off: builds never touch the network. */
function setBuildEnv(exportFile: string, repoUrl: string | null): void {
  process.env.ASTRO_TELEMETRY_DISABLED = "1";
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
    vite: { build: { assetsInlineLimit: 0 } },
  };
}

export interface BuildResult {
  /** HTML files Pagefind read; only pages marked data-pagefind-body become search results. */
  htmlPages: number;
}

/** Validates the export, renders the static site into outDir, then indexes it with Pagefind. */
export async function buildSite(
  exportFile: string,
  outDir: string,
  repoUrl: string | null,
): Promise<BuildResult> {
  loadExport(exportFile);
  validateOutDir(exportFile, outDir);
  setBuildEnv(exportFile, repoUrl);

  const previousCwd = process.cwd();
  try {
    process.chdir(ROOT);
    await build(astroConfig(outDir));
  } finally {
    process.chdir(previousCwd);
  }

  // Write marker file to allow rebuilds
  writeFileSync(`${outDir}/.repowiki-site`, "");

  const { index, errors } = await pagefind.createIndex({ forceLanguage: "en" });
  try {
    if (index === undefined) throw new Error(`pagefind: ${errors.join("; ")}`);
    const added = await index.addDirectory({ path: outDir });
    if (added.errors.length > 0) throw new Error(`pagefind: ${added.errors.join("; ")}`);
    const written = await index.writeFiles({ outputPath: `${outDir}/pagefind` });
    if (written.errors.length > 0) throw new Error(`pagefind: ${written.errors.join("; ")}`);
    return { htmlPages: added.page_count };
  } finally {
    await pagefind.close();
  }
}

/** Serves a built site on http://127.0.0.1:4321/ until the process is stopped. */
export async function previewSite(outDir: string): Promise<void> {
  process.env.ASTRO_TELEMETRY_DISABLED = "1";
  const previousCwd = process.cwd();
  try {
    process.chdir(ROOT);
    await preview(astroConfig(outDir));
  } finally {
    process.chdir(previousCwd);
  }
}
