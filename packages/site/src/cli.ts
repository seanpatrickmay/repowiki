import { parseSiteArgs, UsageError } from "./args.ts";
import { buildSite, previewSite } from "./build.ts";
import { ExportError } from "./load.ts";

try {
  const args = parseSiteArgs(process.argv.slice(2));
  if (args.command === "build") {
    const { htmlPages } = await buildSite(args.exportFile ?? "", args.outDir, args.repoUrl, {
      inflight: args.inflight,
      base: args.base,
    });
    console.log(`built ${args.outDir} (${htmlPages} HTML pages)`);
  } else {
    await previewSite(args.outDir, args.base);
  }
} catch (error) {
  if (error instanceof UsageError || error instanceof ExportError) {
    console.error(error.message);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
  throw error;
}
