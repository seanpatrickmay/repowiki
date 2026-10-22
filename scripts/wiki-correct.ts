import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WikiExport } from "@repowiki/core";
import {
  correctClaims,
  crossFeatureEdges,
  DEFAULT_MAX_FILE_BYTES,
  indexRepo,
  readHistory,
  readSources,
} from "@repowiki/engine";
import { createClaudeProvider, createLedger, type Provider, totalsOf } from "@repowiki/llm";
import { parseCorrectArgs, readRequests } from "./correct-cli.ts";
import { CliError, loadModels } from "./manifest-cli.ts";
import { resolveOutPath } from "./out-path.ts";
import { exitWithError, requireApiKey } from "./wiki-cli.ts";

/**
 * pnpm wiki:correct <repo> --export <file> --requests <file> --out <file> (the sentence
 * corrections spec): corrects the flagged claims of the export's latest revisions against <repo>
 * at the export's head, writes the corrected export to --out, and prints `{outcomes}` as JSON.
 * Calls are unbatched; one with no API key fails before anything is written. It never writes in
 * <repo>, and never prints a note.
 */
async function main(): Promise<void> {
  const args = parseCorrectArgs(process.argv.slice(2));
  const repo = resolve(args.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new CliError(`no such repository: ${args.repo}`);
  }
  const out = resolveOutPath(repo, args.out);
  if (out === null) {
    throw new CliError(
      "refusing to write inside the documented repository; choose an --out path elsewhere",
    );
  }
  const requests = readRequests(args.requestsPath);
  const exp = WikiExport.parse(JSON.parse(readFileSync(args.exportPath, "utf8")));
  const models = loadModels(args.config);

  const index = await indexRepo(repo, exp.head);
  const symbols = new Map(index.files.map((f) => [f.path, f.symbols]));
  const ctx = {
    sha: index.sha,
    sources: await readSources(repo, index.sha, DEFAULT_MAX_FILE_BYTES),
    symbolsOf: (path: string) => symbols.get(path) ?? [],
    commits: readHistory(repo, index.sha),
  };
  const edges = crossFeatureEdges(index, exp.manifest, new Set(exp.pages.map((p) => p.featureId)));
  const ledger = createLedger();
  const runId = `wiki-correct-${index.sha}-${new Date().toISOString()}`;
  let claude: Provider | undefined;
  let keyless = false;
  const provider: Provider = {
    generate: (request) => {
      keyless ||= !process.env.ANTHROPIC_API_KEY;
      requireApiKey("wiki:correct");
      claude ??= createClaudeProvider({
        models,
        ledger,
        runId,
        run: { kind: "update", sha: index.sha },
      });
      return claude.generate(request);
    },
  };
  // A failed call refuses its article's requests; one made with no key fails the run instead,
  // before anything is written, so a job without one fails rather than reporting refusals.
  const done = await correctClaims({
    exp,
    requests,
    ctx,
    provider,
    now: new Date().toISOString(),
    edges,
  });
  if (keyless) requireApiKey("wiki:correct");
  writeFileSync(out, `${JSON.stringify(WikiExport.parse(done.exp))}\n`);
  const totals = totalsOf(ledger.entries());
  if (totals.calls > 0) {
    console.error(
      `${totals.calls} calls: ${totals.tokens.in} input, ${totals.tokens.out} output tokens, $${totals.usd.toFixed(4)}`,
    );
  }
  console.log(JSON.stringify({ outcomes: done.outcomes }));
}

try {
  await main();
} catch (err) {
  exitWithError(err);
}
