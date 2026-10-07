import { describe, expect, it } from "vitest";
import { redactGitHub } from "./redact.ts";

describe("redactGitHub (R25)", () => {
  it("redacts a token glued to a word by an underscore or a digit, never a word like ghost_town", () => {
    // Built at run time, so no token-shaped literal sits in the source.
    const token = ["ghp", "Q7r6Q7r6Q7r6Q7r6"].join("_");
    for (const text of [`GH_TOKEN_${token}`, `x1${token}`, `(${token})`])
      expect(redactGitHub(text, {})).not.toContain("Q7r6");
    expect(redactGitHub("a ghost_town", {})).toBe("a ghost_town");
  });
});
