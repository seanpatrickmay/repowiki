import { buildSite } from "@repowiki/site";

/**
 * Builds one site in its own process (spec 2 S13): `buildSite` changes the working directory and
 * the environment, which a server serving other requests must not share.
 * Usage: site-child.ts <export.json> <out-dir> <repo-url> <base>
 */
const [exportFile, outDir, repoUrl, base] = process.argv.slice(2);
if (
  exportFile === undefined ||
  outDir === undefined ||
  repoUrl === undefined ||
  base === undefined
) {
  process.stderr.write("usage: site-child.ts <export> <out> <repo-url> <base>\n");
  process.exit(2);
}
buildSite(exportFile, outDir, repoUrl, { inflight: false, base }).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
