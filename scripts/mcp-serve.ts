import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commitOf, createServer, logLine, serveStdio, topLevel } from "@repowiki/mcp";
import { CliError } from "./manifest-cli.ts";
import { parseServeArgs, prepareEnvironment, registrationHelp, startLine } from "./mcp-cli.ts";

/**
 * pnpm mcp:serve <repo> [--out dir] [--compare-to rev], or `node scripts/mcp-serve.ts …`, which
 * is what an MCP client launches (spec v2 #5 §6.1): serves the wiki in <out>/export.json (default
 * ~/.repowiki/<basename of repo>) to one client over stdin and stdout, reading code from <repo>'s
 * git objects. Makes no LLM call: ANTHROPIC_API_KEY is deleted from its environment at start and
 * no .env is read. Writes nothing: stdout carries only protocol lines, stderr one start line and
 * one-line errors. Exits 0 when stdin ends or on SIGTERM; 1 when there is nothing to serve.
 */
async function main(): Promise<void> {
  prepareEnvironment(process.env);
  const args = parseServeArgs(process.argv.slice(2));
  const script = fileURLToPath(import.meta.url);
  if (args.help) {
    const repo = args.repo === null ? null : resolve(args.repo);
    process.stdout.write(
      registrationHelp(script, repo, args.out === null ? null : resolve(args.out)),
    );
    return;
  }
  const dir = resolve(args.repo ?? ".");
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new CliError(`no such repository: ${args.repo}`);
  // A subdirectory serves its repository, whose wiki is named after the top level.
  const repo = topLevel(dir);
  const out = resolve(args.out ?? join(homedir(), ".repowiki", basename(repo)));
  let pinned: string | null = null;
  if (args.compareTo !== null) {
    pinned = commitOf(repo, args.compareTo);
    if (pinned === null)
      throw new CliError(`--compare-to ${args.compareTo} names no commit in ${repo}`);
  }
  const server = createServer({
    repo,
    exportFile: join(out, "export.json"),
    pinned,
    log: (line) => console.error(line),
  });
  const { wiki, headDate } = server.served();
  console.error(startLine({ repo: wiki.repo, head: wiki.head, headDate, out, pinned }));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  // The client stopped reading (EPIPE): no one is left to answer, so end quietly.
  process.stdout.on("error", () => process.exit(0));
  await serveStdio(server.protocol, { input: process.stdin, output: process.stdout });
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(logLine(`repowiki mcp: ${message}`));
  process.exit(error instanceof CliError ? 2 : 1);
}
