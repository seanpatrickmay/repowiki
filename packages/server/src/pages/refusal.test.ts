import { describe, expect, it } from "vitest";
import { refusalPage } from "./refusal.ts";

describe("refusal pages (Contract §11)", () => {
  it("are never cached: they name the signed-in account and its CSRF token", () => {
    const reply = refusalPage("not-found", { csrf: "c", login: "demo-dev" });
    expect(reply.status).toBe(404);
    expect(reply.headers?.["cache-control"]).toBe("private, no-store");
  });
});
