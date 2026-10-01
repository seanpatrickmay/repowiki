import { describe, expect, it } from "vitest";
import { Claim } from "./claim.ts";
import { bodyClaim } from "./test-fixtures.ts";

describe("Claim", () => {
  it("accepts a cited fact", () => {
    expect(Claim.parse(bodyClaim())).toEqual(bodyClaim());
  });

  it("rejects empty text", () => {
    expect(Claim.safeParse(bodyClaim({ text: "" })).success).toBe(false);
  });

  it("rejects unknown kinds", () => {
    expect(Claim.safeParse({ ...bodyClaim(), kind: "opinion" }).success).toBe(false);
  });

  it("rejects a malformed staleSince sha", () => {
    expect(Claim.safeParse(bodyClaim({ staleSince: "HEAD" })).success).toBe(false);
  });
});
