import { fileURLToPath } from "node:url";
import type { AstroInlineConfig } from "astro";
import { build, preview } from "astro";
import * as pagefind from "pagefind";
import { loadExport } from "./load.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  setBuildEnv(exportFile, repoUrl);
  await build(astroConfig(outDir));

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
  await preview(astroConfig(outDir));
}
