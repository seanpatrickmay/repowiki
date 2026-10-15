import { describe, expect, it } from "vitest";
import { REFUSAL_CODES, REFUSALS, RefusalCode } from "./refusals.ts";
import { ok, refused } from "./result.ts";

describe("refusals (Contract spec §11)", () => {
  it("has exactly the spec's 28 codes (ADR-0012), each with one entry", () => {
    expect(REFUSAL_CODES).toHaveLength(28);
    expect(new Set(REFUSAL_CODES).size).toBe(28);
    expect(REFUSAL_CODES).not.toContain("needs-review-flags");
    expect(REFUSAL_CODES).not.toContain("contribution-missing");
    expect(Object.keys(REFUSALS)).toEqual([...REFUSAL_CODES]);
  });

  it("gives every code an HTTP error status and one plain sentence", () => {
    for (const code of REFUSAL_CODES) {
      const { status, message } = REFUSALS[code];
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
      expect(message, code).toMatch(/^[A-Z][^\n<>]*[.)]$/);
    }
  });

  it("pins the statuses the server relies on", () => {
    expect(REFUSALS["not-signed-in"].status).toBe(401);
    expect(REFUSALS["not-found"].status).toBe(404);
    expect(REFUSALS.withdrawn.status).toBe(410);
    expect(REFUSALS["stale-revision"].status).toBe(409);
    expect(REFUSALS["plan-project-limit"].status).toBe(402);
    expect(REFUSALS["platform-paused"].status).toBe(503);
  });

  it("marks only a paused platform and a failed job as worth retrying", () => {
    const retryable = REFUSAL_CODES.filter((code) => REFUSALS[code].retryable);
    expect(retryable).toEqual(["platform-paused", "job-failed"]);
  });

  it("parses a known code and refuses an unknown one", () => {
    expect(RefusalCode.safeParse("frozen").success).toBe(true);
    expect(RefusalCode.safeParse("forbidden").success).toBe(false);
  });

  it("builds results with and without detail", () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 });
    expect(refused("frozen")).toEqual({ ok: false, code: "frozen" });
    expect(refused("invalid-input", "title")).toEqual({
      ok: false,
      code: "invalid-input",
      detail: "title",
    });
  });
});
