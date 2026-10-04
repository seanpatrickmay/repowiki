import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { WikiExport } from "@repowiki/core";
import { WikiBuildError } from "@repowiki/engine";
import { accuracySheet, tallySheet } from "@repowiki/eval";
import { CliError } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import { exitWithError } from "./wiki-cli.ts";

const USAGE =
  "usage: pnpm eval:accuracy sheet <repo-path> [--out dir] [feature-id ...]\n       pnpm eval:accuracy tally <sheet>";

/** The sheet's name in the wiki's out dir. */
export const ACCURACY_SHEET = join("eval", "accuracy-review.md");

function parseSheetArgs(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: true, options: { out: { type: "string" } } });
  } catch (err) {
    throw new CliError(USAGE, { cause: err });
  }
}

/**
 * pnpm eval:accuracy: spec §9's accuracy review. `sheet` writes <out>/eval/accuracy-review.md,
 * every claim of the named pages (every active page when none is named) to mark true or false,
 * and never writes over a sheet that exists, since it may hold the author's marks. `tally`
 * counts a marked sheet against the 1-in-50 bar. No LLM call.
 */
function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "tally") {
    const [path, ...extra] = rest;
    if (path === undefined || path === "" || extra.length > 0) throw new CliError(USAGE);
    let tally: ReturnType<typeof tallySheet>;
    try {
      tally = tallySheet(readFileSync(path, "utf8"));
    } catch (err) {
      throw new CliError(`${path}: ${(err as Error).message}`, { cause: err });
    }
    console.log(
      `Reviewed ${tally.reviewed} claims, ${tally.false} false, ${tally.unmarked} not reviewed: ${tally.pass ? "pass" : "fail"} (spec §9 allows at most 1 false claim per 50 reviewed).`,
    );
    for (const id of tally.falseClaims) console.log(`false: ${id}`);
    return;
  }
  if (command !== "sheet") throw new CliError(USAGE);
  const { positionals, values } = parseSheetArgs(rest);
  const [repoArg, ...featureIds] = positionals;
  if (repoArg === undefined || repoArg === "") throw new CliError(USAGE);
  const repo = resolve(repoArg);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new CliError(`no such repository: ${repoArg}`);
  }
  const out = resolveOutDir(repo, values.out ?? join(homedir(), ".repowiki", basename(repo)));
  if (out === null) {
    throw new CliError(
      "refusing to write inside the documented repository; choose an --out path elsewhere",
    );
  }
  const exportPath = join(out, "export.json");
  if (!existsSync(exportPath))
    throw new WikiBuildError(`no export at ${exportPath}; run pnpm wiki:build first`);
  const wiki = WikiExport.parse(JSON.parse(readFileSync(exportPath, "utf8")));
  const paged = new Set(wiki.pages.map((p) => p.featureId));
  const unknown = featureIds.filter((id) => !paged.has(id));
  if (unknown.length > 0) {
    throw new CliError(
      `no page for ${unknown.slice(0, 5).join(", ")}; the pages are ${[...paged].sort().join(", ")}`,
    );
  }
  const path = join(out, ACCURACY_SHEET);
  if (existsSync(path)) {
    throw new CliError(
      `${path} exists and may hold your marks; move it aside to write a new sheet`,
    );
  }
  const sheet = accuracySheet(wiki, featureIds);
  mkdirSync(join(out, "eval"), { recursive: true });
  writeFileSync(path, sheet, { flag: "wx" });
  console.log(`Wrote ${path}: ${sheet.match(/^- \[ \] /gm)?.length ?? 0} claims to review`);
}

try {
  main();
} catch (err) {
  exitWithError(err);
}
