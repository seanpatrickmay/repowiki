import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { cut, oneLine, type ToolDefinition, type ToolOutput, type ToolSet } from "@repowiki/query";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.ts";
import { encodeMessage } from "./stdio.ts";

/** How long a request waits for its reply before the client gives up on it. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** The server failed to start, answered with an error, or did not answer in time. */
export class McpClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface McpClientOptions {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

/** What the server said when it was initialized. */
export interface McpServerInfo {
  protocolVersion: string;
  serverInfo: { name: string; version: string; title?: string };
  instructions: string | null;
}

/** A tool as tools/list describes it. */
export interface McpTool extends ToolDefinition {
  title?: string;
  annotations?: Record<string, unknown>;
}

export interface McpClient {
  info: McpServerInfo;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown): Promise<ToolOutput>;
  /** What the server wrote to stderr so far. */
  stderr(): string;
  /** Ends the server's input and waits for it to exit. */
  close(): Promise<{ code: number | null }>;
}

type Reply = { result?: unknown; error?: { code: number; message: string } };

/**
 * A minimal MCP client over stdio (spec v2 #5 §4): spawns the server, initializes it with the
 * newest protocol revision and sends notifications/initialized, then sends one request per call
 * and matches replies by id. For the eval's mcp agents and pnpm mcp:probe; no other feature.
 */
export async function connectMcp(options: McpClientOptions): Promise<McpClient> {
  const child: ChildProcessWithoutNullStreams = spawn(options.command, [...options.args], {
    env: options.env,
    cwd: options.cwd,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  let stderr = "";
  let buffered = "";
  let exited: { code: number | null } | null = null;
  const exit = new Promise<{ code: number | null }>((resolve) => {
    child.on("close", (code) => {
      exited = { code };
      const last = stderr.trim().split("\n").at(-1) ?? "";
      for (const { reject } of waiting.values()) {
        reject(
          new McpClientError(
            `the MCP server exited (code ${code})${last === "" ? "" : `: ${last}`}`,
          ),
        );
      }
      waiting.clear();
      resolve(exited);
    });
  });
  child.on("error", (error) => {
    for (const { reject } of waiting.values())
      reject(new McpClientError(`cannot start the MCP server: ${error.message}`));
    waiting.clear();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let nl = buffered.indexOf("\n");
    while (nl !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      nl = buffered.indexOf("\n");
      let reply: Reply & { id?: unknown };
      try {
        reply = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof reply.id !== "number") continue;
      waiting.get(reply.id)?.resolve(reply);
      waiting.delete(reply.id);
    }
  });
  let nextId = 0;
  const request = (method: string, params?: unknown): Promise<unknown> => {
    if (exited !== null) return Promise.reject(new McpClientError("the MCP server has exited"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new McpClientError(`no reply to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      waiting.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          if (reply.error !== undefined)
            reject(new McpClientError(`${method}: ${reply.error.message}`));
          else resolve(reply.result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(
        encodeMessage({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
      );
    });
  };
  const init = (await request("initialize", {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
    capabilities: {},
    clientInfo: { name: "repowiki-client", version: "0.0.0" },
  })) as {
    protocolVersion: string;
    serverInfo: McpServerInfo["serverInfo"];
    instructions?: string;
  };
  child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return {
    info: {
      protocolVersion: init.protocolVersion,
      serverInfo: init.serverInfo,
      instructions: init.instructions ?? null,
    },
    async listTools() {
      const result = (await request("tools/list")) as { tools: McpTool[] };
      return result.tools;
    },
    async callTool(name, args) {
      const result = (await request("tools/call", { name, arguments: args })) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
      return { text, isError: result.isError === true };
    },
    stderr: () => stderr,
    close() {
      if (exited === null) child.stdin.end();
      return exit;
    },
  };
}

/**
 * The server's tools as a ToolSet for an agent: definitions as tools/list gives them (name,
 * description, input schema), each call a tools/call. An unknown tool is an error result, as
 * toolSet's is, so the agent can correct itself.
 */
export async function mcpToolSet(client: McpClient): Promise<ToolSet> {
  const tools = await client.listTools();
  const definitions: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const names = new Set(definitions.map((d) => d.name));
  return {
    definitions,
    async run(name, input) {
      if (!names.has(name)) {
        return {
          text: `no tool named ${cut(oneLine(name), 60)}; the tools are ${[...names].join(", ")}`,
          isError: true,
        };
      }
      return client.callTool(name, input);
    },
  };
}
