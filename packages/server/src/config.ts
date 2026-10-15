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
  /** The worker listener's port (`/internal/*`, `/llm/*`); production only, null elsewhere (S1). */
  internalPort: number | null;
  host: string;
  /** What workers report as the engine version (`REPOWIKI_ENGINE_VERSION`). */
  engineVersion: string;
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
  const port = portOf(env.PORT, 8787, "PORT");
  // Production names the commit it runs (S17); a missing one is reported with the rest.
  const engineVersion =
    mode === "production"
      ? need("REPOWIKI_ENGINE_VERSION")
      : env.REPOWIKI_ENGINE_VERSION?.trim() || "dev";
  if (engineVersion !== "" && !ENGINE_VERSION.test(engineVersion)) {
    throw new ConfigError("REPOWIKI_ENGINE_VERSION must be 1 to 64 letters, digits or ._+-.");
  }

  if (mode === "production") {
    const origin = need("PUBLIC_ORIGIN");
    const internalPort = portOf(env.INTERNAL_PORT, 8788, "INTERNAL_PORT");
    if (internalPort === port) throw new ConfigError("INTERNAL_PORT must differ from PORT.");
    const config: Config = {
      mode,
      origin,
      port,
      internalPort,
      host: env.HOST ?? "0.0.0.0",
      engineVersion,
      tokenKey: Buffer.alloc(0),
      signupAllowlist: allowlist(env.SIGNUP_ALLOWLIST),
      anthropicApiKey: need("ANTHROPIC_API_KEY"),
      database: { kind: "postgres", url: need("DATABASE_URL") },
      objects: {
        kind: "s3",
        endpoint: need("R2_ENDPOINT").replace(/\/$/, ""),
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
    if (!reachesPort(config.runner.internalUrl, internalPort)) {
      throw new ConfigError("INTERNAL_URL must be http://<host>:<INTERNAL_PORT>, with no path.");
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
    internalPort: null,
    host: "127.0.0.1",
    engineVersion,
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

function portOf(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`${name} is invalid.`);
  }
  return port;
}

/** The worker's own check on its version (packages/worker env.ts), so a bad one fails here. */
const ENGINE_VERSION = /^[A-Za-z0-9._+-]{1,64}$/;

/**
 * Workers must reach the worker listener, never the public one: the URL names its port. It is
 * plain http on Fly's private network (the listener has no TLS), and an origin only: the worker
 * appends `/internal/...` and `/llm/...` to it, so a path or trailing slash would break them.
 */
function reachesPort(url: string, port: number): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      parsed.port === String(port) &&
      parsed.pathname === "/" &&
      !url.endsWith("/") &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function allowlist(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login !== "");
}

/** 32 bytes in standard, padded base64; `Buffer.from` alone would skip stray characters. */
const TOKEN_KEY = /^[A-Za-z0-9+/]{43}=$/;

function tokenKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (!TOKEN_KEY.test(value) || key.length !== 32)
    throw new ConfigError("TOKEN_KEY must be 32 bytes, base64-encoded.");
  return key;
}
