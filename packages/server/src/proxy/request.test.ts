import { describe, expect, it } from "vitest";
import { BatchCreate, MessageParams, refusedBeta } from "./request.ts";

const message = (extra: object = {}) => ({
  model: "claude-haiku-4-5",
  max_tokens: 1000,
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});
const accepts = (value: unknown) => MessageParams.safeParse(value).success;

describe("the proxy's request shape (spec 2 S11, M14c A1)", () => {
  it("accepts what the engine sends", () => {
    expect(accepts(message())).toBe(true);
    expect(
      accepts(
        message({
          system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
          output_config: { format: { type: "json_schema", schema: { type: "object" } } },
          temperature: 0,
        }),
      ),
    ).toBe(true);
  });

  it("refuses streams, tools, non-text blocks, a cache TTL and unknown fields", () => {
    expect(accepts(message({ stream: true }))).toBe(false);
    expect(accepts(message({ tools: [] }))).toBe(false);
    expect(accepts(message({ tool_choice: { type: "auto" } }))).toBe(false);
    expect(accepts(message({ mcp_servers: [] }))).toBe(false);
    expect(accepts(message({ container: "c" }))).toBe(false);
    expect(accepts(message({ service_tier: "auto" }))).toBe(false);
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "" } };
    expect(accepts(message({ messages: [{ role: "user", content: [image] }] }))).toBe(false);
    const ttl = { type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } };
    expect(accepts(message({ system: [ttl] }))).toBe(false);
    expect(accepts(message({ max_tokens: 64_001 }))).toBe(false);
  });

  it("checks every request of a batch", () => {
    const ok = { requests: [{ custom_id: "a-1", params: message() }] };
    expect(BatchCreate.safeParse(ok).success).toBe(true);
    const bad = { requests: [{ custom_id: "a", params: message({ stream: true }) }] };
    expect(BatchCreate.safeParse(bad).success).toBe(false);
    const id = { requests: [{ custom_id: "../x", params: message() }] };
    expect(BatchCreate.safeParse(id).success).toBe(false);
  });

  it("allows no beta, since the engine sets none", () => {
    expect(refusedBeta(undefined)).toBeNull();
    expect(refusedBeta("")).toBeNull();
    expect(refusedBeta("files-api-2025-04-14, x")).toBe("files-api-2025-04-14");
  });
});
