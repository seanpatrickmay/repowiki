import { HANDLE_PATTERN, isReservedHandle } from "@repowiki/hosted";
import { describe, expect, it } from "vitest";
import { authRoutes } from "./auth.ts";
import { draftRoutes } from "./drafts.ts";
import { internalRoutes } from "./internal.ts";
import { llmRoutes } from "./llm.ts";
import { previewRoutes } from "./preview.ts";
import { jobRoutes } from "./project-jobs.ts";
import { projectRoutes } from "./projects.ts";
import { publishRoutes } from "./publish.ts";
import { testDeps } from "./test-app.ts";

describe("no handle can shadow an app route (Contract §9)", () => {
  it("every app route's first segment is reserved or cannot be a handle", async () => {
    const deps = await testDeps();
    const factories = [
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
    await deps.db.close();
  });
});
