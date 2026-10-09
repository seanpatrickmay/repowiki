import { writeFileSync } from "node:fs";
import { type IndexedFile, indexRepo } from "@repowiki/engine";
import { parseIndexArgs } from "./index-args.ts";
import { resolveOutPath } from "./out-path.ts";

const args = parseIndexArgs(process.argv.slice(2));
if (args === null) {
  console.error("usage: pnpm index:repo <repo-path> [rev] [--out file.json]");
  process.exit(2);
}
const { repo, rev, out } = args;
const target = out === null ? null : resolveOutPath(repo, out);
if (out !== null && target === null) {
  console.error("refusing to write inside the indexed repository; choose an --out path elsewhere");
  process.exit(2);
}

const started = performance.now();
const index = await indexRepo(repo, rev);
const count = (keep: (file: IndexedFile) => boolean) => index.files.filter(keep).length;
const summary = {
  sha: index.sha,
  files: index.files.length,
  byLanguage: {
    python: count((f) => f.language === "python"),
    typescript: count((f) => f.language === "typescript"),
    tsx: count((f) => f.language === "tsx"),
    rust: count((f) => f.language === "rust"),
    fileLevel: count((f) => f.language === null),
  },
  skipped: {
    binary: count((f) => f.skipped === "binary"),
    tooLarge: count((f) => f.skipped === "too-large"),
  },
  invalidPaths: index.invalidPaths.length,
  parseErrors: count((f) => f.parseError),
  symbols: index.files.reduce((total, f) => total + f.symbols.length, 0),
  importEdges: index.imports.length,
  externalImports: index.unresolved.filter((u) => u.external).length,
  unresolvedInternal: index.unresolved.filter((u) => !u.external).length,
  coChange: {
    commitsConsidered: index.coChange.commitsConsidered,
    commitsSkipped: index.coChange.commitsSkipped,
    pairs: index.coChange.pairs.length,
  },
  ms: Math.round(performance.now() - started),
};
if (target !== null) writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
