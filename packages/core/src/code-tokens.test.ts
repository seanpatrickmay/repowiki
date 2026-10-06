import { describe, expect, it } from "vitest";
import { codeTokens, ungroundedCodeToken, writesName } from "./code-tokens.ts";

describe("ungroundedCodeToken", () => {
  it("finds the first code-like token the ground does not write as a whole name", () => {
    const ground = "src/signals/ingest.py\n    if len(signals) >= MAX_SIGNALS:";
    expect(codeTokens("It drops `MAX_SIGNALS` from src/signals/ingest.py.")).toEqual([
      "MAX_SIGNALS",
      "src/signals/ingest.py",
    ]);
    expect(ungroundedCodeToken(ground, "It drops `MAX_SIGNALS` and calls `len()`.")).toBeNull();
    expect(ungroundedCodeToken(ground, "It calls `delete_everything()`.")).toBe(
      "delete_everything()",
    );
    // A part of a longer name is not written: `SIGNALS` is inside `MAX_SIGNALS`.
    expect(writesName(ground, "SIGNALS")).toBe(false);
    expect(ungroundedCodeToken(ground, "It reads `SIGNALS`.")).toBe("SIGNALS");
  });
});
