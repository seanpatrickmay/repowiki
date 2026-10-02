import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite, previewSite } from "./build.ts";
import { fixtureExport } from "./test-fixtures.ts";

// Builds the fixture export and serves it, so the reader can be browsed before a real build exists.
// Every run gets its own directory, so a leftover from an earlier run can never block this one.
const dir = mkdtempSync(join(tmpdir(), "repowiki-demo-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));

const exportFile = join(dir, "export.json");
writeFileSync(exportFile, `${JSON.stringify(fixtureExport(), null, 2)}\n`);
const outDir = join(dir, "site");
await buildSite(exportFile, outDir, "https://github.com/acme/demo-repo");
console.log(`demo export ${exportFile}\nserving ${outDir} at http://127.0.0.1:4321/`);
await previewSite(outDir);
