import { describe, expect, it } from "vitest";
import { takeEnv } from "./env.ts";

const TOKEN = "Abc_-".repeat(8).concat("xyz");

describe("the worker's environment (spec 2 S9, S16)", () => {
  it("parses the environment, then deletes the token and the server's URL from it", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      REPOWIKI_API_URL: "http://127.0.0.1:8787",
      REPOWIKI_JOB_TOKEN: TOKEN,
      REPOWIKI_WORK_DIR: "/w",
    };
    const parsed = takeEnv(env);
    expect(parsed.success && parsed.data.REPOWIKI_JOB_TOKEN).toBe(TOKEN);
    expect(parsed.success && parsed.data.REPOWIKI_WORKER_MODE).toBe("engine");
    expect(env).toEqual({ PATH: "/usr/bin", REPOWIKI_WORK_DIR: "/w" });
  });

  it("deletes them from a bad environment too", () => {
    const env: NodeJS.ProcessEnv = { REPOWIKI_API_URL: "ftp://x", REPOWIKI_JOB_TOKEN: "short" };
    expect(takeEnv(env).success).toBe(false);
    expect(env).toEqual({});
  });
});
