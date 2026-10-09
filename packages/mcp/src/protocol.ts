import { cut, oneLine, type ToolDefinition, type ToolOutput } from "@repowiki/query";

/**
 * The MCP revisions this server speaks, newest first (spec v2 #5 §4.3). A client asking for one
 * gets it; any other request gets the newest, and the client decides whether to go on.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** JSON-RPC 2.0 error codes the server answers with. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

/** The tools a protocol serves; `run` may answer at once or later. */
export interface ProtocolTools {
  definitions: readonly ToolDefinition[];
  run(name: string, input: unknown): ToolOutput | Promise<ToolOutput>;
}

export interface ProtocolOptions {
  version: string;
  /** The initialize result's instructions, built when a client initializes. */
  instructions(): string;
  /** The tools as of this call (the server reloads its export between calls). */
  tools(): ProtocolTools;
  /** Each tool's title for tools/list; a tool without one is listed by its name. */
  titles: Readonly<Record<string, string>>;
  /** Told of an error a tool threw (a git failure, say); the call answers with an error result. */
  onToolError?: (name: string, error: unknown) => void;
}

export interface Protocol {
  /** The reply to one parsed JSON-RPC message, or null for a notification. */
  handle(message: unknown): Promise<object | null>;
  /** The reply to one line of input: a parse error for a line that is not JSON. */
  handleLine(line: string): Promise<object | null>;
}

type Id = string | number;
/** A JSON-RPC id MCP allows: a string or an integer (never null, never a fraction). */
const isId = (id: unknown): id is Id =>
  typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id));

const error = (id: Id | null, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const result = (id: Id, value: object) => ({ jsonrpc: "2.0", id, result: value });

/**
 * The MCP lifecycle over JSON-RPC 2.0 (spec v2 #5 R2, R3, R17), hand-rolled per ADR-0004:
 * initialize, ping, tools/list and tools/call, every answer synchronous in arrival order. A
 * notification never gets a reply; unknown ones and notifications/cancelled are ignored. Requests
 * are answered before initialize too. A batch is refused. An unknown method is -32601, an
 * unknown tool -32602; a tool's bad arguments are a tool result with isError, so the model can
 * correct itself.
 */
export function createProtocol(options: ProtocolOptions): Protocol {
  const handle = async (message: unknown): Promise<object | null> => {
    if (Array.isArray(message)) {
      return error(null, INVALID_REQUEST, "batches are not supported; send one request per line");
    }
    if (typeof message !== "object" || message === null) {
      return error(null, INVALID_REQUEST, "a request is a JSON object");
    }
    const { jsonrpc, id, method, params } = message as Record<string, unknown>;
    const hasId = "id" in message;
    if (jsonrpc !== "2.0" || typeof method !== "string") {
      // A response to a request this server never sent: nothing to answer.
      if (jsonrpc === "2.0" && hasId && ("result" in message || "error" in message)) return null;
      return error(
        isId(id) ? id : null,
        INVALID_REQUEST,
        'a request needs jsonrpc "2.0" and a method',
      );
    }
    if (!hasId) return null;
    if (!isId(id)) return error(null, INVALID_REQUEST, "a request id is a string or an integer");
    const args =
      typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
    switch (method) {
      case "initialize": {
        const asked = args.protocolVersion;
        const protocolVersion =
          SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === asked) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
        return result(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "repowiki", title: "RepoWiki", version: options.version },
          instructions: options.instructions(),
        });
      }
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, {
          tools: options.tools().definitions.map((d) => {
            const title = options.titles[d.name] ?? d.name;
            return {
              name: d.name,
              title,
              description: d.description,
              inputSchema: d.inputSchema,
              annotations: {
                title,
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            };
          }),
        });
      case "tools/call": {
        const tools = options.tools();
        const name = args.name;
        if (typeof name !== "string")
          return error(id, INVALID_PARAMS, "tools/call needs a tool name");
        if (!tools.definitions.some((d) => d.name === name)) {
          const names = tools.definitions.map((d) => d.name).join(", ");
          return error(
            id,
            INVALID_PARAMS,
            `no tool named ${JSON.stringify(cut(oneLine(name), 60))}; the tools are ${names}`,
          );
        }
        let output: ToolOutput;
        try {
          output = await tools.run(name, args.arguments ?? {});
        } catch (thrown) {
          options.onToolError?.(name, thrown);
          const why = thrown instanceof Error ? thrown.message : String(thrown);
          output = { text: `${name} failed: ${cut(oneLine(why), 300)}`, isError: true };
        }
        return result(id, {
          content: [{ type: "text", text: output.text }],
          isError: output.isError,
        });
      }
      default:
        return error(
          id,
          METHOD_NOT_FOUND,
          `method ${JSON.stringify(cut(oneLine(method), 60))} is not supported`,
        );
    }
  };
  return {
    handle,
    async handleLine(line) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return error(null, PARSE_ERROR, "the line is not JSON");
      }
      return handle(message);
    },
  };
}
