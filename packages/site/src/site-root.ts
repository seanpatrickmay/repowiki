import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LLMS_TXT_EXPORT_PATH,
  LLMS_TXT_FILE,
  renderLlmsTxt,
  type WikiExport,
} from "@repowiki/core";

/**
 * Puts the wiki's llms.txt and the export it lists at the site's root (F07), both from the one
 * export the build validated, so they always agree even if the export file changed mid-build.
 */
export function writeSiteRoot(outDir: string, wiki: WikiExport): void {
  writeFileSync(join(outDir, LLMS_TXT_EXPORT_PATH), `${JSON.stringify(wiki, null, 2)}\n`);
  writeFileSync(join(outDir, LLMS_TXT_FILE), renderLlmsTxt(wiki));
}
