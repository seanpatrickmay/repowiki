import { fileURLToPath } from "node:url";
import { connectMcp, mcpToolSet } from "@repowiki/mcp";
import type { ToolSet } from "@repowiki/query";

/** The MCP server's script, which the eval launches as an MCP client would. */
export const MCP_SERVE_SCRIPT = fileURLToPath(
  new URL("../../../scripts/mcp-serve.ts", import.meta.url),
);

/** The MCP server's six tools for the eval's mcp agents, and how to stop the server. */
export interface McpAgentTools {
  tools: ToolSet;
  close(): Promise<void>;
}

export interface McpAgentToolsOptions {
  repo: string;
  /** The out dir whose export.json the server serves. */
  out: string;
  /** The compare commit, pinned: the wiki's head, so freshness adds no noise the repo agent lacks (R19). */
  compareTo: string;
}

/**
 * Launches the MCP server through its real stdio transport and gives its tools to an agent (spec
 * v2 #5 R19): the eval measures what a coding agent gets. The server's environment carries no
 * ANTHROPIC_ variable.
 */
export async function openMcpTools(options: McpAgentToolsOptions): Promise<McpAgentTools> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("ANTHROPIC_")),
  );
  const client = await connectMcp({
    command: process.execPath,
    args: [MCP_SERVE_SCRIPT, options.repo, "--out", options.out, "--compare-to", options.compareTo],
    env,
  });
  try {
    return {
      tools: await mcpToolSet(client),
      close: async () => {
        await client.close();
      },
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
