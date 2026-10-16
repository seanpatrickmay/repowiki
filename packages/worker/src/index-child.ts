import { indexReport } from "./index-report.ts";

/**
 * Phase 2's index, run alone in a child process under a time and heap limit (indexing.ts): indexes
 * `<repo> <sha>` and prints, as one JSON object on stdout, the indexed count, each file's
 * language, lines and skip reason, and the tree's technologies (ADR-0014). The parent gives it a
 * git environment with no user or system configuration (gitEnv); git here also gets no prompt and
 * no global config, whatever it inherits.
 */
const [repo, sha] = process.argv.slice(2);
if (repo === undefined || sha === undefined) {
  process.stderr.write("usage: index-child.ts <repo> <sha>\n");
  process.exit(2);
}
const git = {
  env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
};
const report = await indexReport({
  repo,
  sha,
  git,
  warn: (line) => process.stderr.write(`${line}\n`),
});
process.stdout.write(JSON.stringify(report));
