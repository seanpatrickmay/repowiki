import { fileURLToPath } from "node:url";
import { connectMcp, type McpClient, McpClientError, mcpToolSet } from "@repowiki/mcp";
import { cut, oneLine, type ToolSet } from "@repowiki/query";

/** The MCP server's script, which the eval launches as an MCP client would. */
export const MCP_SERVE_SCRIPT = fileURLToPath(
  new URL("../../../scripts/mcp-serve.ts", import.meta.url),
);

/** What lost() says once the restarted server has died too. */
export const MCP_SERVER_LOST =
  "the MCP server exited again after one restart; the run stops here (a rerun resumes it)";

/** The MCP server's six tools for the eval's mcp agents, and how to stop the server. */
export interface McpAgentTools {
  tools: ToolSet;
  /** A line saying why the run should stop (the server died after its one restart), or null. */
  lost(): string | null;
  close(): Promise<void>;
}

export interface McpAgentToolsOptions {
  repo: string;
  /** The out dir whose export.json the server serves. */
  out: string;
  /** The compare commit, pinned: the wiki's head, so freshness adds no noise the repo agent lacks (R19). */
  compareTo: string;
  /** Told, one line each, of what the server writes that is no reply (the client ignores it). */
  log?: (line: string) => void;
}

/**
 * Launches the MCP server through its real stdio transport and gives its tools to an agent (spec
 * v2 #5 R19): the eval measures what a coding agent gets. The server's environment carries no
 * ANTHROPIC_ variable. A server that dies is started again once per run, at the next call (the
 * call that saw it die failed, and its answer is recorded as failed); when the restarted one dies
 * too, or cannot start, lost() says so and every later call rejects.
 */
export async function openMcpTools(
  options: McpAgentToolsOptions,
  connect: typeof connectMcp = connectMcp,
): Promise<McpAgentTools> {
  let closing = false;
  let lost: string | null = null;
  const start = async (restarted: boolean) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("ANTHROPIC_")),
    );
    const client: McpClient = await connect({
      command: process.execPath,
      args: [
        MCP_SERVE_SCRIPT,
        options.repo,
        "--out",
        options.out,
        "--compare-to",
        options.compareTo,
      ],
      env,
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    try {
      const served = { client, tools: await mcpToolSet(client), alive: true };
      void client.exit.then(() => {
        served.alive = false;
        if (restarted && !closing) lost ??= MCP_SERVER_LOST;
      });
      return served;
    } catch (error) {
      await client.close();
      throw error;
    }
  };
  let served = await start(false);
  let restart: Promise<void> | null = null;
  const live = async (): Promise<ToolSet> => {
    if (served.alive) return served.tools;
    restart ??= start(true).then(
      (next) => {
        served = next;
      },
      (error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        lost ??= `the MCP server could not be started again: ${cut(oneLine(why), 200)}`;
        throw error;
      },
    );
    await restart;
    if (!served.alive) throw new McpClientError("the MCP server has exited");
    return served.tools;
  };
  return {
    tools: {
      definitions: served.tools.definitions,
      run: async (name, input) => (await live()).run(name, input),
    },
    lost: () => lost,
    close: async () => {
      closing = true;
      await served.client.close();
    },
  };
}
