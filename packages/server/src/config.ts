import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Origin, Plan } from "@repowiki/hosted";
import { loadProfile } from "./github/profile.ts";

export class ConfigError extends Error {}

export type Mode = "production" | "development" | "demo";

export interface Config {
  mode: Mode;
  /** The signed-in app: OAuth, dashboard, project and review pages (ADR-0012). */
  appOrigin: string;
  /** Public pages, their wikis and previews: `<publicOrigin>/<handle>/<slug>` (ADR-0012). */
  publicOrigin: string;
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
  /** A GitHub snapshot the fake GitHub serves (`REPOWIKI_PROFILE`, development only, M14g). */
  localProfile: string | null;
  /** New accounts' plan (`REPOWIKI_LOCAL_PLAN`); never set in production. */
  localPlan: Plan;
  /** Stripe billing (billing spec B11), or null when the keys are unset: billing is off. */
  stripe: StripeConfig | null;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** A sandbox key: no real charges, and the billing pages say so. */
  testMode: boolean;
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
    for (const name of ["REPOWIKI_PROFILE", "REPOWIKI_LOCAL_PLAN"]) {
      if (env[name] !== undefined) throw new ConfigError(`${name} is for local testing only.`);
    }
    const appOrigin = need("APP_ORIGIN");
    const publicOrigin = need("PUBLIC_ORIGIN");
    const internalPort = portOf(env.INTERNAL_PORT, 8788, "INTERNAL_PORT");
    if (internalPort === port) throw new ConfigError("INTERNAL_PORT must differ from PORT.");
    const config: Config = {
      mode,
      appOrigin,
      publicOrigin,
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
      localProfile: null,
      localPlan: "free",
      stripe: stripeOf(env),
    };
    const key = need("TOKEN_KEY");
    if (missing.length > 0) {
      throw new ConfigError(`Missing environment variables: ${missing.join(", ")}.`);
    }
    for (const [name, origin] of [
      ["APP_ORIGIN", appOrigin],
      ["PUBLIC_ORIGIN", publicOrigin],
    ] as const) {
      if (!Origin.safeParse(origin).success) {
        throw new ConfigError(`${name} must be RepoWiki's own https origin with no path.`);
      }
    }
    apart(appOrigin, publicOrigin);
    if (!reachesPort(config.runner.internalUrl, internalPort)) {
      throw new ConfigError("INTERNAL_URL must be http://<host>:<INTERNAL_PORT>, with no path.");
    }
    config.tokenKey = tokenKey(key);
    return config;
  }

  // Two loopback hosts on one port (ADR-0012): different origins, so host-only cookies stay apart.
  const appOrigin = env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
  const publicOrigin = env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;
  for (const [name, origin] of [
    ["APP_ORIGIN", appOrigin],
    ["PUBLIC_ORIGIN", publicOrigin],
  ] as const) {
    if (!LOOPBACK.test(origin)) {
      throw new ConfigError(`Outside production, ${name} must be a loopback http origin.`);
    }
  }
  apart(appOrigin, publicOrigin);
  const dataDir = mode === "demo" ? null : (env.DATA_DIR ?? join(tmpdir(), "repowiki-dev"));
  const scratch = dataDir ?? join(tmpdir(), `repowiki-demo-${process.pid}`);
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const plan = Plan.safeParse(env.REPOWIKI_LOCAL_PLAN ?? "free");
  if (!plan.success) throw new ConfigError("REPOWIKI_LOCAL_PLAN must be free or pro.");
  const localProfile = env.REPOWIKI_PROFILE?.trim() || null;
  const signupAllowlist = allowlist(env.SIGNUP_ALLOWLIST);
  if (localProfile !== null) {
    if (mode !== "development") throw new ConfigError("REPOWIKI_PROFILE is for development only.");
    if (clientId || clientSecret) {
      throw new ConfigError("REPOWIKI_PROFILE serves a fake GitHub; unset GITHUB_CLIENT_ID.");
    }
    signupAllowlist.push(profileLogin(localProfile));
  }
  return {
    mode,
    appOrigin,
    publicOrigin,
    port,
    internalPort: null,
    host: "127.0.0.1",
    engineVersion,
    tokenKey: env.TOKEN_KEY
      ? tokenKey(env.TOKEN_KEY)
      : dataDir === null
        ? randomBytes(32)
        : storedTokenKey(dataDir),
    signupAllowlist,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    database: { kind: "pglite", dataDir: dataDir === null ? null : join(dataDir, "db") },
    objects: { kind: "fs", root: join(scratch, "objects") },
    runner: { kind: "local", internalUrl: appOrigin },
    github:
      mode !== "demo" && clientId && clientSecret
        ? { kind: "oauth", clientId, clientSecret }
        : { kind: "fake" },
    localProfile,
    localPlan: plan.data,
    stripe: stripeOf(env),
  };
}

/** Both Stripe keys or neither (billing spec B11); a key is checked by its prefix, never echoed. */
function stripeOf(env: Env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() || null;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || null;
  if (secretKey === null && webhookSecret === null) return null;
  if (secretKey === null || webhookSecret === null) {
    throw new ConfigError("Set both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, or neither.");
  }
  if (!/^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+$/.test(secretKey)) {
    throw new ConfigError("STRIPE_SECRET_KEY must be a secret (sk_) or restricted (rk_) key.");
  }
  if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) {
    throw new ConfigError("STRIPE_WEBHOOK_SECRET must be a webhook signing secret (whsec_).");
  }
  return { secretKey, webhookSecret, testMode: /^(?:sk|rk)_test_/.test(secretKey) };
}

/** The app and its public pages on different hosts: cookies are scoped by host, not port. */
function apart(appOrigin: string, publicOrigin: string): void {
  const host = (origin: string) => new URL(origin).hostname.replace(/\.$/, "");
  if (host(appOrigin) === host(publicOrigin)) {
    throw new ConfigError("APP_ORIGIN and PUBLIC_ORIGIN must be on different hosts.");
  }
}

/** The profile's login, lowercased like the allowlist; a snapshot that does not load is refused. */
function profileLogin(path: string): string {
  try {
    return loadProfile(path).user.login.toLowerCase();
  } catch {
    throw new ConfigError("REPOWIKI_PROFILE must name a snapshot from pnpm hosted:profile.");
  }
}

/**
 * Development's token key, kept in `<dataDir>/token-key` (mode 0600) so GitHub tokens stored in
 * one run decrypt in the next; created on first use.
 */
function storedTokenKey(dataDir: string): Buffer {
  const path = join(dataDir, "token-key");
  mkdirSync(dataDir, { recursive: true });
  try {
    writeFileSync(path, randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(path, 0o600);
  try {
    return tokenKey(readFileSync(path, "utf8").trim());
  } catch {
    throw new ConfigError(
      `${path} must hold 32 bytes, base64-encoded; delete it to make a new one.`,
    );
  }
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
