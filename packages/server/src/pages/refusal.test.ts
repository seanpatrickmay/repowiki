import { describe, expect, it } from "vitest";
import { refusalPage } from "./refusal.ts";

describe("refusal pages (Contract §11)", () => {
  it("are never cached: they name the signed-in account and its CSRF token", () => {
    const reply = refusalPage("not-found", { csrf: "c", login: "demo-dev" });
    expect(reply.status).toBe(404);
    expect(reply.headers?.["cache-control"]).toBe("private, no-store");
  });

  it("point a plan limit to Pro, and nothing else (billing spec B12)", () => {
    const session = { csrf: "c", login: "demo-dev" };
    for (const code of [
      "plan-project-limit",
      "plan-generation-limit",
      "plan-refresh-limit",
      "frozen",
      "repo-too-large",
    ] as const) {
      expect(String(refusalPage(code, session).body), code).toContain(
        '<a href="/billing">See Pro</a>',
      );
    }
    expect(String(refusalPage("not-found", session).body)).not.toContain("See Pro");
  });
});
