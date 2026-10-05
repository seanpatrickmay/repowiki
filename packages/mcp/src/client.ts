import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { cut, oneLine, type ToolDefinition, type ToolOutput, type ToolSet } from "@repowiki/query";
import { z } from "zod";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.ts";
import { encodeMessage } from "./stdio.ts";

/** How long a request waits for its reply before the client gives up on it. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** How long close() waits after ending the server's input before SIGTERM, and again before SIGKILL. */
export const DEFAULT_CLOSE_GRACE_MS = 2_000;
/** The most of the server's stderr kept (its end). */
export const MAX_STDERR_CHARS = 64 * 1024;
/** The longest line read from the server; a longer one is dropped to its end. */
export const MAX_REPLY_LINE_CHARS = 4 * 1024 * 1024;

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
  /** The server's environment (default: this process's), always without ANTHROPIC_ variables. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  closeGraceMs?: number;
  /** Told, one line each, of what the server wrote that is not a reply to a pending request. */
  log?: (line: string) => void;
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
  /** What the server wrote to stderr so far (at most its last MAX_STDERR_CHARS). */
  stderr(): string;
  /**
   * Ends the server's input and waits for it to exit: SIGTERM after closeGraceMs, SIGKILL after
   * as long again. Always resolves; later calls reject.
   */
  close(): Promise<{ code: number | null }>;
  /** Settles when the server exits, for whatever reason (close() returns it too). */
  exit: Promise<{ code: number | null }>;
}

/** A reply to a request: an error, or a result object; never a request or a notification. */
const Reply = z.union([
  z.object({ id: z.int(), error: z.object({ code: z.int(), message: z.string() }) }),
  z.object({ id: z.int(), result: z.record(z.string(), z.unknown()) }),
]);
type Reply = z.infer<typeof Reply>;

const InitializeResult = z.object({
  protocolVersion: z.string(),
  serverInfo: z.object({ name: z.string(), version: z.string(), title: z.string().optional() }),
  instructions: z.string().optional(),
});
const ToolsListResult = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().default(""),
      inputSchema: z.looseObject({ type: z.literal("object") }),
      title: z.string().optional(),
      annotations: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
const CallToolResult = z.object({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
});

/** The server's text as one short line, for an error message or a log line. */
const shown = (text: string) => cut(oneLine(text), 200);

/**
 * A minimal MCP client over stdio (spec v2 #5 §4): spawns the server (with no ANTHROPIC_
 * variable in its environment), initializes it with the newest protocol revision and sends
 * notifications/initialized, then sends one request per call and matches replies by id. Every
 * line the server writes is checked as a reply; anything else is logged and ignored. A server
 * that fails to initialize, or does not in time, is killed. For the eval's mcp agents and
 * pnpm mcp:probe; no other feature.
 */
export async function connectMcp(options: McpClientOptions): Promise<McpClient> {
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(([name]) => !name.startsWith("ANTHROPIC_")),
  );
  const child: ChildProcessWithoutNullStreams = spawn(options.command, [...options.args], {
    env,
    cwd: options.cwd,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const graceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const log = options.log ?? (() => {});
  const waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  const failAll = (error: McpClientError) => {
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  };
  let stderr = "";
  let buffered = "";
  let dropping = false;
  let closing = false;
  /** Why the server's input failed (it closed it, or died); later calls reject with it at once. */
  let broken: string | null = null;
  let exited: { code: number | null } | null = null;
  let settle: (result: { code: number | null }) => void = () => {};
  const exit = new Promise<{ code: number | null }>((resolve) => {
    settle = resolve;
  });
  const finish = (code: number | null, why: string) => {
    if (exited !== null) return;
    exited = { code };
    failAll(new McpClientError(why));
    settle(exited);
  };
  const exitedWith = (code: number | null, signal: NodeJS.Signals | null) => {
    const last = stderr.trim().split("\n").at(-1) ?? "";
    const how = signal === null ? `code ${code}` : `signal ${signal}`;
    finish(code, `the MCP server exited (${how})${last === "" ? "" : `: ${shown(last)}`}`);
  };
  // "close" comes once the output is read to its end. A child of the server (a wrapper command's)
  // may hold the output open long after the server exited: then "exit", and a grace, is enough.
  let lingering: NodeJS.Timeout | undefined;
  child.on("exit", (code, signal) => {
    lingering = setTimeout(() => exitedWith(code, signal), graceMs);
  });
  child.on("close", (code, signal) => {
    clearTimeout(lingering);
    exitedWith(code, signal);
  });
  child.on("error", (error) => {
    const why = `cannot start the MCP server: ${shown(error.message)}`;
    if (child.pid === undefined) finish(null, why);
    else failAll(new McpClientError(why));
  });
  child.stdin.on("error", (error) => {
    broken ??= `cannot write to the MCP server: ${shown(error.message)}`;
    failAll(new McpClientError(broken));
  });
  // Decoded as streams: a character split across two reads stays one character.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
  });
  const take = (line: string) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return log(`repowiki client: ignored a line that is not JSON: ${shown(line)}`);
    }
    const isRequest = typeof raw === "object" && raw !== null && "method" in raw;
    const reply = isRequest ? null : Reply.safeParse(raw);
    const pending = reply?.success === true ? waiting.get(reply.data.id) : undefined;
    if (reply?.success !== true || pending === undefined) {
      return log(
        `repowiki client: ignored a line that is no pending request's reply: ${shown(line)}`,
      );
    }
    waiting.delete(reply.data.id);
    pending.resolve(reply.data);
  };
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (dropping) dropping = false;
      else take(line);
    }
    if (buffered.length > MAX_REPLY_LINE_CHARS) {
      log(`repowiki client: dropped a line over ${MAX_REPLY_LINE_CHARS} characters`);
      buffered = "";
      dropping = true;
    }
  });
  let nextId = 0;
  const request = (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    if (closing) return Promise.reject(new McpClientError("the MCP client is closed"));
    if (exited !== null) return Promise.reject(new McpClientError("the MCP server has exited"));
    if (broken !== null) return Promise.reject(new McpClientError(broken));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new McpClientError(`no reply to ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      waiting.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          if ("error" in reply)
            reject(new McpClientError(`${method}: ${shown(reply.error.message)}`));
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
  /** A request's result, checked against `schema`. */
  const ask = async <T>(schema: z.ZodType<T>, method: string, params?: unknown): Promise<T> => {
    const result = schema.safeParse(await request(method, params));
    if (!result.success)
      throw new McpClientError(`${method}: the MCP server's result is not valid`);
    return result.data;
  };
  const close = () => {
    if (!closing) {
      closing = true;
      failAll(new McpClientError("the MCP client is closed"));
      if (exited === null) {
        child.stdin.end();
        const term = setTimeout(() => child.kill("SIGTERM"), graceMs);
        const kill = setTimeout(() => child.kill("SIGKILL"), 2 * graceMs);
        void exit.then(() => {
          clearTimeout(term);
          clearTimeout(kill);
        });
      }
    }
    return exit;
  };
  let init: z.infer<typeof InitializeResult>;
  try {
    init = await ask(InitializeResult, "initialize", {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: "repowiki-client", version: "0.0.0" },
    });
  } catch (error) {
    closing = true;
    child.stdin.end();
    child.kill("SIGKILL");
    await exit;
    throw error;
  }
  child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return {
    info: {
      protocolVersion: init.protocolVersion,
      serverInfo: init.serverInfo,
      instructions: init.instructions ?? null,
    },
    async listTools() {
      return (await ask(ToolsListResult, "tools/list")).tools;
    },
    async callTool(name, args) {
      const result = await ask(CallToolResult, "tools/call", { name, arguments: args });
      const text = result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
      return { text, isError: result.isError === true };
    },
    stderr: () => stderr,
    close,
    exit,
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
