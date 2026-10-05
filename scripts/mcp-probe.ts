import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcp, logLine } from "@repowiki/mcp";
import { MAX_TOOL_RESULT_CHARS } from "@repowiki/query";
import { CliError } from "./manifest-cli.ts";
import { parseProbeArgs, prepareEnvironment, probeReport, runProbe } from "./mcp-cli.ts";

/**
 * pnpm mcp:probe <repo> [--out dir] (spec v2 #5 §6.1): launches mcp-serve.ts through its real
 * stdio transport, runs a fixed list of calls, and prints each call's time and result size: the
 * smoke test after registering, and the latency evidence for exit criterion 3. No LLM call; it
 * writes nothing (the server writes nothing either).
 */
async function main(): Promise<void> {
  prepareEnvironment(process.env);
  const parsed = parseProbeArgs(process.argv.slice(2));
  const dir = resolve(parsed.repo);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new CliError(`no such repository: ${parsed.repo}`);
  }
  const serve = fileURLToPath(new URL("./mcp-serve.ts", import.meta.url));
  const args = [serve, dir, ...(parsed.out === null ? [] : ["--out", resolve(parsed.out)])];
  let client: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    const rows = await runProbe(async () => {
      client = await connectMcp({ command: process.execPath, args, env: process.env });
      return client;
    });
    process.stdout.write(probeReport(rows, MAX_TOOL_RESULT_CHARS));
  } finally {
    await client?.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    logLine(`repowiki mcp:probe: ${error instanceof Error ? error.message : String(error)}`),
  );
  process.exit(error instanceof CliError ? 2 : 1);
}
