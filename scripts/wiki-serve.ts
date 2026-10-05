import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type AskSession,
  createAskHandler,
  createAskSession,
  exportHash,
  openAnswerCache,
  securityHeaders,
} from "@repowiki/ask";
import { WikiBuildError } from "@repowiki/engine";
import { createClaudeToolProvider, createLedger } from "@repowiki/llm";
import { loadExport } from "@repowiki/query";
import { CONTENT_SECURITY_POLICY } from "@repowiki/site/csp";
import { CliError, loadModels } from "./manifest-cli.ts";
import { resolveOutDir } from "./out-dir.ts";
import {
  parseWikiServeArgs,
  serveEstimateLine,
  siteIsCurrent,
  totalsLine,
  typicalQuestionUsd,
} from "./serve-cli.ts";
import { listenLoopback, serveRequests } from "./serve-static.ts";
import { exitWithError } from "./wiki-cli.ts";

/** How long a stop waits for a question in flight before it exits anyway. */
const STOP_WAIT_MS = 30_000;

/**
 * pnpm wiki:serve <repo> (spec v2 #4 §7): serves <out>/site/ (default out ~/.repowiki/<basename
 * of repo>) and /api/ask from one origin on 127.0.0.1, rebuilding the site first when its copy
 * of the export is not <out>/export.json's. A bad --config or a busy port fails before that
 * build: the port is bound first, answering 503 until the site is ready. Prints the estimate
 * and both caps (with or without a key), then answers questions with the ask role's model when
 * ANTHROPIC_API_KEY is set (read only from RepoWiki's .env, never printed); without a key or
 * with --no-ask it serves the same site with routing only. Holds no build lock: it answers from
 * the export it read at start. Writes only <out>/site/ and <out>/ask/answers.jsonl, never
 * inside <repo>.
 */
async function main(): Promise<void> {
  const args = parseWikiServeArgs(process.argv.slice(2));
  const repo = resolve(args.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new CliError(`no such repository: ${args.repo}`);
  }
  const out = resolveOutDir(repo, args.out ?? join(homedir(), ".repowiki", basename(repo)));
  if (out === null) {
    throw new CliError(
      "refusing to write inside the documented repository; choose an --out path elsewhere",
    );
  }
  const exportPath = join(out, "export.json");
  if (!existsSync(exportPath)) {
    throw new WikiBuildError(`no export at ${exportPath}; run pnpm wiki:build first`);
  }
  const wiki = loadExport(exportPath);
  // Everything that can fail fast does so before a site build that can take minutes.
  const models = loadModels(args.config);
  let port = args.port;
  const building = securityHeaders(CONTENT_SECURITY_POLICY);
  let handle: (request: IncomingMessage, response: ServerResponse) => Promise<void> = async (
    _request,
    response,
  ) => {
    response.writeHead(503, {
      ...building,
      "cache-control": "no-store",
      "retry-after": "5",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("The site is being built; try again in a moment.\n");
  };
  const listening = await listenLoopback((request, response) => handle(request, response), port);
  port = listening.port;
  const siteDir = join(out, "site");
  if (args.repoUrl !== null || !siteIsCurrent(siteDir, wiki)) {
    console.error(
      `building the site (${args.repoUrl !== null ? "--repo-url given" : "export changed"})`,
    );
    const { buildSite } = await import("@repowiki/site/build");
    await buildSite(exportPath, siteDir, args.repoUrl);
  }
  let session: AskSession | null = null;
  const routing = args.ask ? "no-key" : "disabled";
  if (!args.ask) console.error("ask: routing only (--no-ask)");
  else {
    // The estimate and both caps come first, key or not, so the owner sees what a question costs.
    console.error(
      serveEstimateLine({
        model: models.ask,
        typicalUsd: typicalQuestionUsd(wiki, models.ask),
        questionUsd: args.questionUsd,
        maxUsd: args.maxUsd,
      }),
    );
    if (!process.env.ANTHROPIC_API_KEY) console.error("ask: routing only (no ANTHROPIC_API_KEY)");
    else {
      session = createAskSession({
        wiki,
        provider: createClaudeToolProvider({
          models,
          ledger: createLedger(),
          runId: `ask-${new Date().toISOString()}`,
        }),
        model: models.ask,
        questionUsd: args.questionUsd,
        maxUsd: args.maxUsd,
        cache: openAnswerCache(join(out, "ask"), exportHash(wiki), (line) => console.error(line)),
        log: (line) => console.error(line),
      });
    }
  }
  const ask = createAskHandler({
    get port() {
      return port;
    },
    head: wiki.head,
    session,
    routing,
    csp: CONTENT_SECURITY_POLICY,
    log: (line) => console.error(line),
  });
  handle = serveRequests({ siteDir, csp: CONTENT_SECURITY_POLICY, port: () => port, ask });
  console.log(
    `serving http://127.0.0.1:${port}/ (the wiki at ${wiki.head.slice(0, 7)}; Ctrl-C to stop)`,
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    listening.server.close();
    await Promise.race([
      session?.idle(),
      new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref()),
    ]);
    console.error(totalsLine(session?.totals() ?? { questions: 0, cached: 0, usd: 0 }));
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

try {
  await main();
} catch (err) {
  exitWithError(err);
}
