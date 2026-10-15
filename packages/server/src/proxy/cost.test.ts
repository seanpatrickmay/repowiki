import { describe, expect, it } from "vitest";
import { actualMicros, OUTPUT_RESERVE_SHARE, reserveMicros } from "./cost.ts";

describe("proxy cost arithmetic (spec 2 S11, M14c A2)", () => {
  it("reserves the counted input at the cache-write rate and a share of max_tokens", () => {
    expect(OUTPUT_RESERVE_SHARE).toBe(0.25);
    // Haiku 4.5: $1.25 per million cache-write tokens and $5 output = 1.25 and 5 micros a token.
    expect(reserveMicros("claude-haiku-4-5", 10_000, 8000, false)).toBe(12_500 + 10_000);
    expect(reserveMicros("claude-haiku-4-5", 10_000, 8000, true)).toBe(11_250);
    expect(reserveMicros("claude-haiku-4-5-20251001", 1, 1, false)).toBe(3);
    expect(reserveMicros("gpt-4", 1, 1, false)).toBeNull();
  });

  it("prices actual usage with cache tokens, rounding up", () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 40,
    };
    expect(actualMicros("claude-haiku-4-5", usage, false)).toBe(1000 + 1000 + 10 + 50);
    expect(actualMicros("claude-haiku-4-5", usage, true)).toBe(1030);
    expect(actualMicros("claude-haiku-4-5", { input_tokens: 1, output_tokens: 0 }, true)).toBe(1);
    expect(actualMicros("gpt-4", usage, false)).toBeNull();
  });
});
