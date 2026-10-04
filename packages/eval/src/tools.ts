import type { ToolDefinition } from "@repowiki/llm";
import { z } from "zod";
import { cut, oneLine } from "./text.ts";

/** What one tool call returns to the model. */
export interface ToolOutput {
  text: string;
  isError: boolean;
}

/** The tools one agent has, and how to run a call to one of them. */
export interface ToolSet {
  definitions: readonly ToolDefinition[];
  run(name: string, input: unknown): ToolOutput;
}

/**
 * The most characters any tool result holds (about 3,300 tokens of code). Each tool pages its
 * own output below this and says how to read on; this is the backstop.
 */
export const MAX_TOOL_RESULT_CHARS = 12_000;

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
      try {
        const text = run(parsed.data);
        return { text: capped(text), isError: false };
      } catch (error) {
        if (error instanceof ToolError) return { text: error.message, isError: true };
        throw error;
      }
    },
  };
}

/** A set of tools: an unknown tool name is an error result naming the tools there are. */
export function toolSet(tools: readonly Tool[]): ToolSet {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return {
    definitions: tools.map((tool) => tool.definition),
    run(name, input) {
      const tool = byName.get(name);
      if (tool !== undefined) return tool.run(input);
      const names = [...byName.keys()].join(", ");
      return {
        text: `no tool named ${cut(oneLine(name), 60)}; the tools are ${names}`,
        isError: true,
      };
    },
  };
}
