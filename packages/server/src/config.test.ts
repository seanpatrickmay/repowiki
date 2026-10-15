import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const production = {
  REPOWIKI_MODE: "production",
  PUBLIC_ORIGIN: "https://repowiki.dev",
  DATABASE_URL: "postgres://u:p@db.example/repowiki?sslmode=require",
  TOKEN_KEY: KEY,
  GITHUB_CLIENT_ID: "Iv1.abc",
  GITHUB_CLIENT_SECRET: "s3cret",
  SIGNUP_ALLOWLIST: "SeanPatrickMay, friend",
  ANTHROPIC_API_KEY: "sk-ant-x",
  R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  R2_BUCKET: "repowiki",
  R2_ACCESS_KEY_ID: "id",
  R2_SECRET_ACCESS_KEY: "secret",
  FLY_API_TOKEN: "fly",
  FLY_WORKER_APP: "repowiki-workers",
  WORKER_IMAGE: "registry.fly.io/repowiki-worker:1",
  INTERNAL_URL: "http://repowiki.internal:8787",
};

describe("loadConfig (spec 2 S17)", () => {
  it("parses a complete production environment", () => {
    const config = loadConfig(production);
    expect(config).toMatchObject({
      mode: "production",
      origin: "https://repowiki.dev",
      port: 8787,
      signupAllowlist: ["seanpatrickmay", "friend"],
      database: { kind: "postgres", url: production.DATABASE_URL },
      objects: { kind: "s3", bucket: "repowiki" },
      runner: { kind: "fly", app: "repowiki-workers" },
      github: { kind: "oauth", clientId: "Iv1.abc" },
    });
    expect(config.tokenKey).toHaveLength(32);
  });

  it("names every missing production variable and never echoes a value", () => {
    const { TOKEN_KEY, GITHUB_CLIENT_SECRET, ...rest } = production;
    expect(TOKEN_KEY && GITHUB_CLIENT_SECRET).toBeTruthy();
    let error: unknown;
    try {
      loadConfig({ ...rest, ANTHROPIC_API_KEY: "sk-ant-should-not-appear" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain("TOKEN_KEY");
    expect(message).toContain("GITHUB_CLIENT_SECRET");
    expect(message).not.toContain("sk-ant");
  });

  it("refuses an http or provider origin in production and a short token key", () => {
    expect(() => loadConfig({ ...production, PUBLIC_ORIGIN: "http://repowiki.dev" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...production, PUBLIC_ORIGIN: "https://x.fly.dev" })).toThrow(
      ConfigError,
    );
    const short = Buffer.alloc(16).toString("base64");
    expect(() => loadConfig({ ...production, TOKEN_KEY: short })).toThrow(ConfigError);
  });

  it("runs development on loopback with local twins and nothing required", () => {
    const config = loadConfig({ REPOWIKI_MODE: "development", DATA_DIR: "/tmp/rw" });
    expect(config).toMatchObject({
      mode: "development",
      origin: "http://127.0.0.1:8787",
      database: { kind: "pglite", dataDir: "/tmp/rw/db" },
      objects: { kind: "fs", root: "/tmp/rw/objects" },
      runner: { kind: "local" },
      github: { kind: "fake" },
      anthropicApiKey: null,
    });
    expect(config.tokenKey).toHaveLength(32);
  });

  it("uses real GitHub OAuth in development when it is configured", () => {
    const config = loadConfig({
      REPOWIKI_MODE: "development",
      DATA_DIR: "/tmp/rw",
      GITHUB_CLIENT_ID: "Iv1.dev",
      GITHUB_CLIENT_SECRET: "dev",
    });
    expect(config.github).toEqual({ kind: "oauth", clientId: "Iv1.dev", clientSecret: "dev" });
  });

  it("keeps the demo in memory", () => {
    expect(loadConfig({ REPOWIKI_MODE: "demo" })).toMatchObject({
      database: { kind: "pglite", dataDir: null },
      github: { kind: "fake" },
    });
  });

  it("refuses a non-loopback origin outside production", () => {
    expect(() =>
      loadConfig({ REPOWIKI_MODE: "development", PUBLIC_ORIGIN: "http://example.com" }),
    ).toThrow(ConfigError);
  });
});
