import { LlmRole } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, resolveModels } from "./provider.ts";

describe("DEFAULT_MODELS", () => {
  it("gives every role, the ask role included, claude-haiku-5-5, but the eval agent's tool loop", () => {
    expect(Object.keys(DEFAULT_MODELS).sort()).toEqual([...LlmRole.options].sort());
    const { evalAgent, ...rest } = DEFAULT_MODELS;
    expect(new Set(Object.values(rest))).toEqual(new Set(["claude-haiku-5-5"]));
    expect(evalAgent).toBe("claude-haiku-4-5");
  });

  it("takes the ask role's model from a config file", () => {
    expect(resolveModels({ models: { ask: "claude-sonnet-5-5" } })).toEqual({
      ...DEFAULT_MODELS,
      ask: "claude-sonnet-5-5",
    });
  });
});
