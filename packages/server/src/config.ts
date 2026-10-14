import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Origin } from "@repowiki/hosted";

export class ConfigError extends Error {}

export type Mode = "production" | "development" | "demo";

export interface Config {
  mode: Mode;
  origin: string;
  port: number;
  host: string;
  tokenKey: Buffer;
  signupAllowlist: string[];
  anthropicApiKey: string | null;
  database: { kind: "postgres"; url: string } | { kind: "pglite"; dataDir: string | null };
  objects:
    | { kind: "s3"; endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }
    | { kind: "fs"; root: string };
  runner:
    | { kind: "fly"; apiToken: string; app: string; image: string; internalUrl: string }
    | { kind: "local"; internalUrl: string };
  github: { kind: "oauth"; clientId: string; clientSecret: string } | { kind: "fake" };
}

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/;

/** The server's configuration from the environment (spec 2 S17); never echoes a value. */
export function loadConfig(env: Env): Config {
  const mode = (env.REPOWIKI_MODE ?? "development") as Mode;
  if (!["production", "development", "demo"].includes(mode)) {
    throw new ConfigError("REPOWIKI_MODE must be production, development or demo.");
  }
  const missing: string[] = [];
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new ConfigError("PORT is invalid.");

  if (mode === "production") {
    const origin = need("PUBLIC_ORIGIN");
    const config: Config = {
      mode,
      origin,
      port,
      host: env.HOST ?? "0.0.0.0",
      tokenKey: Buffer.alloc(0),
      signupAllowlist: allowlist(env.SIGNUP_ALLOWLIST),
      anthropicApiKey: need("ANTHROPIC_API_KEY"),
      database: { kind: "postgres", url: need("DATABASE_URL") },
      objects: {
        kind: "s3",
        endpoint: need("R2_ENDPOINT"),
        bucket: need("R2_BUCKET"),
        accessKeyId: need("R2_ACCESS_KEY_ID"),
        secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
      },
      runner: {
        kind: "fly",
        apiToken: need("FLY_API_TOKEN"),
        app: need("FLY_WORKER_APP"),
        image: need("WORKER_IMAGE"),
        internalUrl: need("INTERNAL_URL"),
      },
      github: {
        kind: "oauth",
        clientId: need("GITHUB_CLIENT_ID"),
        clientSecret: need("GITHUB_CLIENT_SECRET"),
      },
    };
    const key = need("TOKEN_KEY");
    if (missing.length > 0) {
      throw new ConfigError(`Missing environment variables: ${missing.join(", ")}.`);
    }
    if (!Origin.safeParse(origin).success) {
      throw new ConfigError("PUBLIC_ORIGIN must be RepoWiki's own https origin with no path.");
    }
    config.tokenKey = tokenKey(key);
    return config;
  }

  const origin = env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
  if (!LOOPBACK.test(origin)) {
    throw new ConfigError("Outside production, PUBLIC_ORIGIN must be a loopback http origin.");
  }
  const dataDir = mode === "demo" ? null : (env.DATA_DIR ?? join(tmpdir(), "repowiki-dev"));
  const scratch = dataDir ?? join(tmpdir(), `repowiki-demo-${process.pid}`);
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  return {
    mode,
    origin,
    port,
    host: "127.0.0.1",
    tokenKey: env.TOKEN_KEY ? tokenKey(env.TOKEN_KEY) : randomBytes(32),
    signupAllowlist: allowlist(env.SIGNUP_ALLOWLIST),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    database: { kind: "pglite", dataDir: dataDir === null ? null : join(dataDir, "db") },
    objects: { kind: "fs", root: join(scratch, "objects") },
    runner: { kind: "local", internalUrl: origin },
    github:
      mode !== "demo" && clientId && clientSecret
        ? { kind: "oauth", clientId, clientSecret }
        : { kind: "fake" },
  };
}

function allowlist(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login !== "");
}

function tokenKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new ConfigError("TOKEN_KEY must be 32 bytes, base64-encoded.");
  return key;
}
