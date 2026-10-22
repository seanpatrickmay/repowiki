import { HANDLE_PATTERN, isReservedHandle } from "@repowiki/hosted";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../app.ts";
import { accountRoutes } from "./account.ts";
import { authRoutes } from "./auth.ts";
import { billingRoutes } from "./billing.ts";
import { draftRoutes } from "./drafts.ts";
import { internalRoutes } from "./internal.ts";
import { landingRoutes } from "./landing.ts";
import { llmRoutes } from "./llm.ts";
import { previewRoutes } from "./preview.ts";
import { jobRoutes } from "./project-jobs.ts";
import { projectRoutes } from "./projects.ts";
import { publishRoutes } from "./publish.ts";
import { testDeps } from "./test-app.ts";

let deps: Deps;
// Setting up the database takes seconds on a busy machine: in a hook, not the test's own budget.
beforeAll(async () => {
  deps = await testDeps();
});
afterAll(async () => deps.db.close());

describe("no handle can shadow an app route (Contract §9)", () => {
  it("every app route's first segment is reserved or cannot be a handle", async () => {
    const factories = [
      landingRoutes,
      accountRoutes,
      billingRoutes,
      authRoutes,
      projectRoutes,
      draftRoutes,
      jobRoutes,
      internalRoutes,
      llmRoutes,
      previewRoutes,
      publishRoutes,
    ];
    const first = new Set(
      factories.flatMap((f) => f(deps)).map((r) => r.pattern.split("/")[1] ?? ""),
    );
    const open = [...first].filter(
      (s) => s.startsWith(":") || (HANDLE_PATTERN.test(s) && !isReservedHandle(s)),
    );
    expect(open).toEqual([]);
  });
});
