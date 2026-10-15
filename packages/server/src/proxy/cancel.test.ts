import { describe, expect, it } from "vitest";
import { cancelBatches } from "./cancel.ts";

describe("cancelBatches (fresh review I3)", () => {
  it("cancels every batch at once, each under its own timeout, and logs failures by name", async () => {
    let inFlight = 0;
    let most = 0;
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      signals.push(init?.signal);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      if (String(input).includes("/b2/")) throw new TypeError("fetch failed sk-real");
      return new Response("{}", { status: String(input).includes("/b3/") ? 500 : 200 });
    };
    const lines: object[] = [];
    const anthropic = { url: "https://api.anthropic.test", key: "sk-real", fetch: fetchFn };
    await cancelBatches(anthropic, ["b1", "b2", "b3"], (line) => lines.push(line));
    expect(most).toBe(3);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(3);
    expect(lines).toEqual(
      expect.arrayContaining([
        { batch: "cancel-failed", error: "TypeError" },
        { batch: "cancel-refused", status: 500 },
      ]),
    );
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain("sk-real");
  });
});
