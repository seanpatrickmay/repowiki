import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";
import { adaProfile, writeProfile } from "./github/test-profile.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "repowiki-config-"));

const KEY = Buffer.alloc(32, 7).toString("base64");
const production = {
  REPOWIKI_MODE: "production",
  APP_ORIGIN: "https://app.repowiki.dev",
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
  INTERNAL_URL: "http://repowiki.internal:8788",
  REPOWIKI_ENGINE_VERSION: "abc1234",
};

describe("loadConfig (spec 2 S17)", () => {
  it("parses a complete production environment", () => {
    const config = loadConfig(production);
    expect(config).toMatchObject({
      mode: "production",
      appOrigin: "https://app.repowiki.dev",
      publicOrigin: "https://repowiki.dev",
      port: 8787,
      signupAllowlist: ["seanpatrickmay", "friend"],
      database: { kind: "postgres", url: production.DATABASE_URL },
      objects: { kind: "s3", bucket: "repowiki" },
      runner: { kind: "fly", app: "repowiki-workers" },
      github: { kind: "oauth", clientId: "Iv1.abc" },
    });
    expect(config.tokenKey).toHaveLength(32);
  });

  it("listens for workers on INTERNAL_PORT, 8788 by default", () => {
    expect(loadConfig(production).internalPort).toBe(8788);
    const moved = { INTERNAL_PORT: "9000", INTERNAL_URL: "http://repowiki.internal:9000" };
    expect(loadConfig({ ...production, ...moved }).internalPort).toBe(9000);
    expect(loadConfig({ REPOWIKI_MODE: "demo" }).internalPort).toBeNull();
  });

  it("refuses a worker port that is the public port, invalid, or not INTERNAL_URL's", () => {
    for (const env of [
      { INTERNAL_PORT: "8787" },
      { INTERNAL_PORT: "0" },
      { INTERNAL_PORT: "x" },
      { INTERNAL_URL: "http://repowiki.internal:8787" },
      { INTERNAL_URL: "http://repowiki.internal" },
      { INTERNAL_URL: "ftp://repowiki.internal:8788" },
      { INTERNAL_URL: "not a url" },
      // Plain http on Fly's private network, with nothing after the port.
      { INTERNAL_URL: "https://repowiki.internal:8788" },
      { INTERNAL_URL: "http://repowiki.internal:8788/" },
      { INTERNAL_URL: "http://repowiki.internal:8788/a" },
      { INTERNAL_URL: "http://repowiki.internal:8788?a" },
      { INTERNAL_URL: "http://u:p@repowiki.internal:8788" },
    ]) {
      expect(() => loadConfig({ ...production, ...env }), JSON.stringify(env)).toThrow(ConfigError);
    }
  });

  it("names the engine version workers report: required in production, dev elsewhere (S17)", () => {
    expect(loadConfig(production).engineVersion).toBe("abc1234");
    const { REPOWIKI_ENGINE_VERSION, ...untagged } = production;
    expect(REPOWIKI_ENGINE_VERSION).toBeTruthy();
    expect(() => loadConfig(untagged)).toThrow(
      /Missing environment variables: REPOWIKI_ENGINE_VERSION\./,
    );
    expect(() => loadConfig({ ...untagged, REPOWIKI_ENGINE_VERSION: " " })).toThrow(ConfigError);
    expect(loadConfig({ REPOWIKI_MODE: "development" }).engineVersion).toBe("dev");
    expect(() => loadConfig({ ...production, REPOWIKI_ENGINE_VERSION: "a b" })).toThrow(
      ConfigError,
    );
  });

  it("strips one trailing slash from R2_ENDPOINT", () => {
    const config = loadConfig({ ...production, R2_ENDPOINT: `${production.R2_ENDPOINT}/` });
    expect(config.objects).toMatchObject({ endpoint: production.R2_ENDPOINT });
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

  it("needs both origins in production, on different hosts, neither a provider's (ADR-0012)", () => {
    const { APP_ORIGIN: _, ...noApp } = production;
    expect(() => loadConfig(noApp)).toThrow(/APP_ORIGIN/);
    const { PUBLIC_ORIGIN: __, ...noPages } = production;
    expect(() => loadConfig(noPages)).toThrow(/PUBLIC_ORIGIN/);
    for (const APP_ORIGIN of [
      "https://repowiki.dev",
      "https://repowiki.dev:8443",
      "https://repowiki.dev.",
    ]) {
      expect(() => loadConfig({ ...production, APP_ORIGIN }), APP_ORIGIN).toThrow(ConfigError);
    }
    for (const origin of [
      "https://x.fly.dev",
      "http://app.repowiki.dev",
      "https://fly.dev",
      "https://app.repowiki.dev:443",
      "https://repowiki.fly.dev.",
    ]) {
      expect(() => loadConfig({ ...production, APP_ORIGIN: origin }), origin).toThrow(ConfigError);
    }
  });

  it("puts the app on 127.0.0.1 and pages on localhost outside production, on one port", () => {
    expect(loadConfig({ REPOWIKI_MODE: "demo", PORT: "9001" })).toMatchObject({
      appOrigin: "http://127.0.0.1:9001",
      publicOrigin: "http://localhost:9001",
      runner: { kind: "local", internalUrl: "http://127.0.0.1:9001" },
    });
    const same = { PUBLIC_ORIGIN: "http://127.0.0.1:9001", APP_ORIGIN: "http://127.0.0.1:9001" };
    expect(() => loadConfig({ REPOWIKI_MODE: "demo", ...same })).toThrow(ConfigError);
    const outside = { REPOWIKI_MODE: "demo", APP_ORIGIN: "http://example.com" };
    expect(() => loadConfig(outside)).toThrow(ConfigError);
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

  it("takes TOKEN_KEY only as 32 bytes of standard, padded base64", () => {
    for (const bad of [
      `${KEY.slice(0, 10)}!${KEY.slice(10)}`,
      KEY.replace("=", ""),
      Buffer.alloc(32, 0xfb).toString("base64url"),
      `${KEY}=`,
    ]) {
      expect(() => loadConfig({ ...production, TOKEN_KEY: bad }), bad).toThrow(ConfigError);
      expect(() => loadConfig({ REPOWIKI_MODE: "development", TOKEN_KEY: bad }), bad).toThrow(
        ConfigError,
      );
    }
    expect(
      loadConfig({ ...production, TOKEN_KEY: Buffer.alloc(32, 0xfb).toString("base64") }).tokenKey,
    ).toEqual(Buffer.alloc(32, 0xfb));
  });

  it("runs development on loopback with local twins and nothing required", () => {
    const dir = scratch();
    const config = loadConfig({ REPOWIKI_MODE: "development", DATA_DIR: dir });
    expect(config).toMatchObject({
      mode: "development",
      appOrigin: "http://127.0.0.1:8787",
      publicOrigin: "http://localhost:8787",
      database: { kind: "pglite", dataDir: join(dir, "db") },
      objects: { kind: "fs", root: join(dir, "objects") },
      runner: { kind: "local" },
      github: { kind: "fake" },
      anthropicApiKey: null,
    });
    expect(config.tokenKey).toHaveLength(32);
  });

  it("uses real GitHub OAuth in development when it is configured", () => {
    const config = loadConfig({
      REPOWIKI_MODE: "development",
      DATA_DIR: scratch(),
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

describe("local profile mode (M14g)", () => {
  it("keeps development's token key in the data directory, so tokens survive a restart", () => {
    const dir = scratch();
    const first = loadConfig({ REPOWIKI_MODE: "development", DATA_DIR: dir });
    const again = loadConfig({ REPOWIKI_MODE: "development", DATA_DIR: dir });
    expect(again.tokenKey).toEqual(first.tokenKey);
    expect(statSync(join(dir, "token-key")).mode & 0o777).toBe(0o600);
    expect(loadConfig({ REPOWIKI_MODE: "development", DATA_DIR: scratch() }).tokenKey).not.toEqual(
      first.tokenKey,
    );
    writeFileSync(join(dir, "token-key"), "short");
    expect(() => loadConfig({ REPOWIKI_MODE: "development", DATA_DIR: dir })).toThrow(ConfigError);
  });

  it("serves a profile in development and admits its login", () => {
    const path = writeProfile(adaProfile());
    const config = loadConfig({
      REPOWIKI_MODE: "development",
      DATA_DIR: scratch(),
      REPOWIKI_PROFILE: path,
      REPOWIKI_LOCAL_PLAN: "pro",
      SIGNUP_ALLOWLIST: "friend",
    });
    expect(config).toMatchObject({
      localProfile: path,
      localPlan: "pro",
      github: { kind: "fake" },
    });
    expect(config.signupAllowlist).toEqual(["friend", "ada"]);
    const plain = loadConfig({ REPOWIKI_MODE: "development", DATA_DIR: scratch() });
    expect(plain).toMatchObject({ localProfile: null, localPlan: "free" });
  });

  it("refuses the local variables in production, a bad plan, a bad profile and OAuth with one", () => {
    const path = writeProfile(adaProfile());
    const dev = { REPOWIKI_MODE: "development", DATA_DIR: scratch() };
    for (const env of [
      { ...production, REPOWIKI_PROFILE: path },
      { ...production, REPOWIKI_LOCAL_PLAN: "pro" },
      { ...production, REPOWIKI_LOCAL_PLAN: "free" },
      { REPOWIKI_MODE: "demo", REPOWIKI_PROFILE: path },
      { ...dev, REPOWIKI_LOCAL_PLAN: "enterprise" },
      { ...dev, REPOWIKI_PROFILE: join(scratch(), "missing.json") },
      { ...dev, REPOWIKI_PROFILE: path, GITHUB_CLIENT_ID: "Iv1.x", GITHUB_CLIENT_SECRET: "x" },
    ]) {
      expect(() => loadConfig(env), JSON.stringify(env)).toThrow(ConfigError);
    }
  });
});
