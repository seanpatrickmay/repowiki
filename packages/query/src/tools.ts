import { z } from "zod";
import { cut, oneLine, toolText } from "./text.ts";

/**
 * A tool the model may call: its name, what it does, and its input's JSON schema. The same shape
 * as @repowiki/llm's ToolDefinition, declared here so query never imports llm; structural typing
 * joins the two.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}

/** What one tool call returns to the model. */
export interface ToolOutput {
  text: string;
  isError: boolean;
}

/**
 * The tools one agent has, and how to run a call to one of them. A call may answer at once or
 * later, so the agent loop awaits it.
 */
export interface ToolSet {
  definitions: readonly ToolDefinition[];
  run(name: string, input: unknown): ToolOutput | Promise<ToolOutput>;
}

/** A ToolSet run in this process, whose calls answer at once. */
export interface LocalToolSet extends ToolSet {
  run(name: string, input: unknown): ToolOutput;
}

/**
 * The most characters any tool result holds (about 3,300 tokens of code). Each tool pages its
 * own output below this and says how to read on; this is the backstop.
 */
export const MAX_TOOL_RESULT_CHARS = 12_000;

/** The most code points of a tool's error message the model is shown. */
export const MAX_TOOL_ERROR_CHARS = 1000;

/** A tool call the model got wrong (a bad input, an unknown page): an error result, not a crash. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface Tool {
  definition: ToolDefinition;
  run(input: unknown): ToolOutput;
}

/** A tool result cut at MAX_TOOL_RESULT_CHARS code points, so no astral character is split. */
function capped(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const chars = [...text];
  return chars.length <= MAX_TOOL_RESULT_CHARS
    ? text
    : `${chars.slice(0, MAX_TOOL_RESULT_CHARS).join("")}\n\u2026 (result cut at ${MAX_TOOL_RESULT_CHARS} characters)`;
}

/** A tool whose input is checked with `input` before `run` sees it. */
export function defineTool<S extends z.ZodType>(
  name: string,
  description: string,
  input: S,
  run: (input: z.infer<S>) => string,
): Tool {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(input) as Record<string, unknown>;
  return {
    definition: {
      name,
      description,
      inputSchema: { ...schema, type: "object" },
    },
    run(raw) {
      const parsed = input.safeParse(raw);
      if (!parsed.success) {
        const why = parsed.error.issues
          .map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`)
          .join("; ");
        return { text: `invalid input for ${name}: ${cut(oneLine(why), 300)}`, isError: true };
      }
      // The backstop for every tool: its result is printable (toolText) and capped, and its error
      // one printable, capped line, whatever the tool itself did.
      try {
        const text = run(parsed.data);
        return { text: capped(toolText(text)), isError: false };
      } catch (error) {
        if (error instanceof ToolError) {
          return { text: cut(oneLine(error.message), MAX_TOOL_ERROR_CHARS), isError: true };
        }
        throw error;
      }
    },
  };
}

/** The error result for a tool name a set does not have: one short line, naming the tools. */
function unknownTool(name: string, names: Iterable<string>): ToolOutput {
  return {
    text: `no tool named ${cut(oneLine(name), 60)}; the tools are ${[...names].join(", ")}`,
    isError: true,
  };
}

/**
 * A set of tools: an unknown tool name is an error result naming the tools there are. Two tools
 * of one name are refused, as the API refuses them.
 */
export function toolSet(tools: readonly Tool[]): LocalToolSet {
  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    if (byName.has(tool.definition.name)) {
      throw new Error(`two tools are named ${tool.definition.name}`);
    }
    byName.set(tool.definition.name, tool);
  }
  return {
    definitions: tools.map((tool) => tool.definition),
    run(name, input) {
      const tool = byName.get(name);
      return tool === undefined ? unknownTool(name, byName.keys()) : tool.run(input);
    },
  };
}
