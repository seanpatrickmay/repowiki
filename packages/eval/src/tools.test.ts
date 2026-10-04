import { describe, expect, it } from "vitest";
import { z } from "zod";
import { count, cut, oneLine, toolText } from "./text.ts";
import { defineTool, MAX_TOOL_RESULT_CHARS, ToolError, toolSet } from "./tools.ts";

const echo = defineTool(
  "echo",
  "Says it back.",
  z.strictObject({ text: z.string().min(1) }),
  ({ text }) => {
    if (text === "fail") throw new ToolError("cannot echo that");
    if (text === "bug") throw new Error("a real bug");
    return text === "long" ? "x".repeat(MAX_TOOL_RESULT_CHARS + 5) : text;
  },
);

describe("defineTool and toolSet", () => {
  it("describes a tool with its input's JSON schema", () => {
    expect(toolSet([echo]).definitions).toEqual([
      {
        name: "echo",
        description: "Says it back.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", minLength: 1 } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("runs a valid call, and answers a bad input, a ToolError and an unknown tool as errors", () => {
    const tools = toolSet([echo]);
    expect(tools.run("echo", { text: "hi" })).toEqual({ text: "hi", isError: false });
    expect(tools.run("echo", { text: "" })).toEqual({
      text: "invalid input for echo: text: Too small: expected string to have >=1 characters",
      isError: true,
    });
    expect(tools.run("echo", { text: "fail" })).toEqual({
      text: "cannot echo that",
      isError: true,
    });
    expect(tools.run("echo\nnow", {})).toEqual({
      text: "no tool named echo now; the tools are echo",
      isError: true,
    });
    expect(() => tools.run("echo", { text: "bug" })).toThrow("a real bug");
  });

  it("cuts a result over the cap and says so", () => {
    const { text } = toolSet([echo]).run("echo", { text: "long" });
    expect(text).toBe(
      `${"x".repeat(MAX_TOOL_RESULT_CHARS)}\n… (result cut at ${MAX_TOOL_RESULT_CHARS} characters)`,
    );
  });
});

describe("text helpers", () => {
  it("keeps newlines and tabs, normalizes CRLF and replaces every other control character", () => {
    expect(toolText("a\r\nb\tc\u0000d\u202Ee\u2028f")).toBe("a\nb\tc\uFFFDd\uFFFDe\uFFFDf");
    expect(oneLine(" a\nb\r\n\tc ")).toBe("a b c");
    expect(cut("abcdef", 4)).toBe("abc…");
    expect(cut("abc", 4)).toBe("abc");
    expect([count(1, "file"), count(2, "file")]).toEqual(["1 file", "2 files"]);
  });
});
