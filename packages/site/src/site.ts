import { parseRepoUrl } from "./args.ts";
import { loadExport } from "./load.ts";
import { buildSiteModel, type SiteModel } from "./model.ts";

let cached: { build: string | undefined; site: SiteModel } | null = null;

/**
 * The site model the current build renders, loaded from REPOWIKI_EXPORT once per build. The cache
 * is keyed by REPOWIKI_BUILD, which buildSite sets afresh on every call, because Astro reuses this
 * module across builds in one process.
 */
export function getSite(): SiteModel {
  const build = process.env.REPOWIKI_BUILD;
  if (cached !== null && cached.build === build) return cached.site;
  const exportFile = process.env.REPOWIKI_EXPORT;
  if (exportFile === undefined || exportFile === "") {
    throw new Error("REPOWIKI_EXPORT is not set; build the site with `pnpm site:build`");
  }
  const repoUrl = process.env.REPOWIKI_REPO_URL;
  const site = buildSiteModel(
    loadExport(exportFile),
    parseRepoUrl(repoUrl === "" ? undefined : repoUrl, "REPOWIKI_REPO_URL"),
  );
  cached = { build, site };
  return site;
}
