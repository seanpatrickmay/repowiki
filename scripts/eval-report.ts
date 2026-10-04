import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { writeReport } from "@repowiki/eval";
import { CliError } from "./manifest-cli.ts";
import { exitWithError } from "./wiki-cli.ts";

const USAGE = "usage: pnpm eval:report <run-dir>";

/**
 * pnpm eval:report <run-dir>: rewrites an eval run's report.md from its files, with no call, so
 * the owner's grades in spot-check.json are counted. It writes spot-check.json first if the run
 * is complete and has none.
 */
function main(): void {
  const [dirArg, ...extra] = process.argv.slice(2);
  if (dirArg === undefined || dirArg === "" || extra.length > 0) throw new CliError(USAGE);
  const runDir = resolve(dirArg);
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
    throw new CliError(`no such run directory: ${dirArg}; ${USAGE}`);
  }
  const { summary, reportPath } = writeReport(runDir);
  const { wiki, repo } = summary.agents;
  const n = summary.info.questions.length;
  console.log(
    `wiki ${wiki.correct} of ${n}, repo ${repo.correct} of ${n}${summary.complete ? "" : " (incomplete)"}`,
  );
  console.log(`Wrote ${reportPath}`);
}

try {
  main();
} catch (err) {
  exitWithError(err);
}
