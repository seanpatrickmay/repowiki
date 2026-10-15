import { indexRepo } from "@repowiki/engine";
import { indexedCount } from "./facts.ts";

/**
 * Phase 2's index, run alone in a child process under a time and heap limit (indexing.ts): indexes
 * `<repo> <sha>` and prints, as one JSON object on stdout, the indexed count and each file's
 * language, lines and skip reason. The parent gives it a git environment with no user or system
 * configuration (gitEnv); git here also gets no prompt and no global config, whatever it inherits.
 */
const [repo, sha] = process.argv.slice(2);
if (repo === undefined || sha === undefined) {
  process.stderr.write("usage: index-child.ts <repo> <sha>\n");
  process.exit(2);
}
const index = await indexRepo(repo, sha, {
  git: {
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  },
});
const files = index.files.map((f) => ({ language: f.language, loc: f.loc, skipped: f.skipped }));
process.stdout.write(JSON.stringify({ indexed: indexedCount(files), files }));
