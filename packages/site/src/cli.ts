import { parseSiteArgs, UsageError } from "./args.ts";
import { buildSite, previewSite } from "./build.ts";
import { ExportError } from "./load.ts";

try {
  const args = parseSiteArgs(process.argv.slice(2));
  if (args.command === "build") {
    const { htmlPages } = await buildSite(args.exportFile ?? "", args.outDir, args.repoUrl);
    console.log(`built ${args.outDir} (${htmlPages} HTML pages)`);
  } else {
    await previewSite(args.outDir);
  }
} catch (error) {
  if (error instanceof UsageError || error instanceof ExportError) {
    console.error(error.message);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
  throw error;
}
