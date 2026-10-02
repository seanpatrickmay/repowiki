import { parseRepoUrl } from "./args.ts";
import { loadExport } from "./load.ts";
import { buildSiteModel, type SiteModel } from "./model.ts";

let cached: SiteModel | null = null;

/** The site model the current build renders, built once per build from REPOWIKI_EXPORT. */
export function getSite(): SiteModel {
  if (cached !== null) return cached;
  const exportFile = process.env.REPOWIKI_EXPORT;
  if (exportFile === undefined || exportFile === "") {
    throw new Error("REPOWIKI_EXPORT is not set; build the site with `pnpm site:build`");
  }
  const repoUrl = process.env.REPOWIKI_REPO_URL;
  cached = buildSiteModel(
    loadExport(exportFile),
    parseRepoUrl(repoUrl === "" ? undefined : repoUrl, "REPOWIKI_REPO_URL"),
  );
  return cached;
}
