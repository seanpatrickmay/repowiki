import { WikiExport } from "@repowiki/core";
import { Facts, Suggestions } from "@repowiki/hosted";
import { describe, expect, it } from "vitest";
import type { Succeeded, WorkerApi } from "./api.ts";
import { runFixture } from "./fixture.ts";

function fakeApi(indexed: "ok" | "too-large" = "ok") {
  const calls: string[] = [];
  let body: Succeeded | null = null;
  let bytes: Uint8Array | null = null;
  const api: WorkerApi = {
    lease: async () => {
      calls.push("lease");
      return {} as never;
    },
    heartbeat: async (step) => {
      calls.push(step);
    },
    indexed: async () => {
      calls.push("indexed");
      return indexed;
    },
    putExport: async (b) => {
      bytes = b;
    },
    succeed: async (b) => {
      body = b;
    },
    fail: async () => {
      calls.push("fail");
    },
  };
  return { api, calls, body: () => body as Succeeded | null, bytes: () => bytes };
}

describe("fixture mode (spec 2 S18)", () => {
  it("walks the engine's steps and uploads a valid export with valid facts and suggestions", async () => {
    const { api, calls, body, bytes } = fakeApi();
    expect(await runFixture(api, { stepMs: 0 })).toBe(true);
    expect(calls).toEqual([
      "lease",
      "fetch",
      "index",
      "indexed",
      "manifest",
      "write",
      "people",
      "facts",
      "render",
    ]);
    const exported = JSON.parse(new TextDecoder().decode(bytes() as Uint8Array));
    expect(WikiExport.safeParse(exported).success).toBe(true);
    const succeeded = body();
    expect(Facts.safeParse(succeeded?.facts).success).toBe(true);
    expect(Suggestions.safeParse(succeeded?.suggestions).success).toBe(true);
    expect(succeeded?.facts.author.commits).toBeGreaterThan(0);
    expect(succeeded?.models.length).toBeGreaterThan(0);
  });

  it("stops when the server finds the repository too large", async () => {
    const { api, calls, body } = fakeApi("too-large");
    expect(await runFixture(api, { stepMs: 0 })).toBe(false);
    expect(calls).toEqual(["lease", "fetch", "index", "indexed"]);
    expect(body()).toBeNull();
  });
});
