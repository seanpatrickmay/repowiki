import type { WikiExport } from "@repowiki/core";
import { loadExport } from "./load.ts";

export interface Site {
  wiki: WikiExport;
  repoUrl: string | null;
}

let cached: Site | null = null;

/** The export the current build renders, loaded once per build from REPOWIKI_EXPORT. */
export function getSite(): Site {
  if (cached !== null) return cached;
  const exportFile = process.env.REPOWIKI_EXPORT;
  if (exportFile === undefined || exportFile === "") {
    throw new Error("REPOWIKI_EXPORT is not set; build the site with `pnpm site:build`");
  }
  const repoUrl = process.env.REPOWIKI_REPO_URL;
  cached = {
    wiki: loadExport(exportFile),
    repoUrl: repoUrl === undefined || repoUrl === "" ? null : repoUrl,
  };
  return cached;
}
