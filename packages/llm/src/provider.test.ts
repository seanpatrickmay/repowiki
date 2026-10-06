import { LlmRole } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, resolveModels } from "./provider.ts";

describe("DEFAULT_MODELS", () => {
  it("gives every role, the ask role included, claude-haiku-4-5", () => {
    expect(Object.keys(DEFAULT_MODELS).sort()).toEqual([...LlmRole.options].sort());
    expect(new Set(Object.values(DEFAULT_MODELS))).toEqual(new Set(["claude-haiku-4-5"]));
  });

  it("takes the ask role's model from a config file", () => {
    expect(resolveModels({ models: { ask: "claude-sonnet-5-5" } })).toEqual({
      ...DEFAULT_MODELS,
      ask: "claude-sonnet-5-5",
    });
  });
});
