import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApp, type Deps } from "./app.ts";
import { stripeApi } from "./billing/stripe.ts";
import { type Config, ConfigError } from "./config.ts";
import { openDatabase } from "./db/migrate.ts";
import { fakeEndpoints, GITHUB, type GitHubEndpoints } from "./github/endpoints.ts";
import { fakeGitHubFetch, profileGitHubFetch } from "./github/fake.ts";
import { loadAvatar, loadProfile } from "./github/profile.ts";
import { byHost } from "./http/hosts.ts";
import type { Route } from "./http/router.ts";
import { type App, type AppServer, listen } from "./http/server.ts";
import { objectStoreFor } from "./objects/open.ts";
import { fakeAnthropicFetch } from "./proxy/fake-anthropic.ts";
import { buildTree } from "./render/build.ts";
import { accountRoutes } from "./routes/account.ts";
import { authRoutes } from "./routes/auth.ts";
import { billingRoutes } from "./routes/billing.ts";
import { billingWebhookRoutes } from "./routes/billing-webhook.ts";
import { draftRoutes } from "./routes/drafts.ts";
import { exampleRoutes } from "./routes/example.ts";
import { internalRoutes } from "./routes/internal.ts";
import { landingRoutes } from "./routes/landing.ts";
import { llmRoutes } from "./routes/llm.ts";
import { PREVIEW_WAIT_MS, previewPageRoutes, previewRoutes } from "./routes/preview.ts";
import { jobRoutes } from "./routes/project-jobs.ts";
import { projectRoutes } from "./routes/projects.ts";
import { publicRoutes } from "./routes/public.ts";
import { publishRoutes } from "./routes/publish.ts";
import { siteRoutes } from "./routes/site.ts";
import { flyRunner } from "./runner/fly-runner.ts";
import { localRunner } from "./runner/local-runner.ts";
import type { JobRunner } from "./runner/runner.ts";
import { startSweeper } from "./runner/sweeper.ts";

const WORKER_ENTRY = fileURLToPath(new URL("../../worker/src/main.ts", import.meta.url));
/** Where the worker's listener binds in production: Fly's private network is IPv6 (S1). */
const WORKER_HOST = "::";
const SWEEP_MS = 30_000;
/** The worker's paths, which the public listener never routes (S1). */
const WORKER_PATH = /^\/(?:internal|llm)(?:\/|$)/;

const stdoutLog = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

/**
 * What a local worker runs: with a local profile, the wiki built for each repository (M14g); the
 * engine only with real GitHub (a repository to clone) and a model key; otherwise the fixture,
 * which uploads core's test export (S18).
 */
export function workerMode(config: Config): "fixture" | "engine" | "import" {
  if (config.localProfile !== null) return "import";
  const real =
    config.mode !== "demo" && config.github.kind === "oauth" && config.anthropicApiKey !== null;
  return real ? "engine" : "fixture";
}

function runnerFor(config: Config, log: (line: object) => void): JobRunner {
  if (config.runner.kind === "fly") {
    const { apiToken, app, image, internalUrl } = config.runner;
    const { engineVersion } = config;
    return flyRunner({ apiToken, app, image, internalUrl, engineVersion, log });
  }
  return localRunner({
    workerEntry: WORKER_ENTRY,
    internalUrl: config.runner.internalUrl,
    mode: workerMode(config),
    profile: config.localProfile,
    log,
  });
}

/** Real GitHub, the demo's fake, or the fake serving a local profile (M14g). */
function githubFetch(config: Config, github: GitHubEndpoints): typeof fetch {
  if (config.github.kind === "oauth") return fetch;
  return config.localProfile === null
    ? fakeGitHubFetch(github)
    : profileGitHubFetch(github, loadProfile(config.localProfile), loadAvatar(config.localProfile));
}

/**
 * Every production seam, or its local stand-in in development and demo (spec 2 S17, S18). An
 * override replaces a seam without building it (tests pass a database).
 */
export async function buildDeps(config: Config, overrides: Partial<Deps> = {}): Promise<Deps> {
  const log = overrides.log ?? stdoutLog;
  const github = config.github.kind === "fake" ? fakeEndpoints(config.appOrigin) : GITHUB;
  const fakeModel = config.mode === "demo" || config.anthropicApiKey === null;
  return {
    config,
    db: overrides.db ?? (await openDatabase(config.database)),
    fetch: githubFetch(config, github),
    github,
    now: () => new Date().toISOString(),
    newId: randomUUID,
    runner: overrides.runner ?? runnerFor(config, log),
    objects: overrides.objects ?? objectStoreFor(config.objects, fetch),
    stripe: config.stripe === null ? null : stripeApi(fetch, config.stripe.secretKey),
    anthropic: fakeModel
      ? {
          url: "https://api.anthropic.test",
          key: config.mode === "demo" ? "demo" : null,
          fetch: fakeAnthropicFetch().fetch,
        }
      : { url: "https://api.anthropic.com", key: config.anthropicApiKey, fetch },
    ...overrides,
    log,
  };
}

/**
 * The app host's routes, the pages host's (public pages, handles last; ADR-0012) and the worker
 * listener's (S1, S14).
 */
export function routeSets(deps: Deps): { app: Route[]; pages: Route[]; worker: Route[] } {
  return {
    app: [
      ...landingRoutes(deps),
      ...authRoutes(deps),
      ...projectRoutes(deps),
      ...draftRoutes(deps),
      ...jobRoutes(deps),
      ...previewRoutes(deps, buildTree, { waitMs: PREVIEW_WAIT_MS }),
      ...publishRoutes(deps),
      ...billingRoutes(deps),
      ...accountRoutes(deps),
      ...billingWebhookRoutes(deps),
    ],
    pages: [
      ...siteRoutes(deps),
      ...exampleRoutes(deps),
      ...previewPageRoutes(deps),
      ...publicRoutes(deps),
    ],
    worker: [...internalRoutes(deps), ...llmRoutes(deps)],
  };
}

export interface Listener {
  app: App;
  port: number;
  host: string;
}

/**
 * Production: the app and pages hosts on PORT, routed by Host (ADR-0012), where `/internal/*`
 * and `/llm/*` are 404 (not handles), and the worker's routes alone on INTERNAL_PORT, which Fly's
 * proxy never exposes. Elsewhere: one loopback listener for both hosts, the worker routes on the
 * app host (the local runner's `INTERNAL_URL` is the app origin).
 */
export function listenersFor(deps: Deps): Listener[] {
  const sets = routeSets(deps);
  const { config } = deps;
  const pages = createApp(deps, sets.pages, { host: "pages" });
  if (config.internalPort === null) {
    const app = byHost(config, { app: createApp(deps, [...sets.worker, ...sets.app]), pages });
    return [{ app, port: config.port, host: config.host }];
  }
  const notFound = createApp(deps, []);
  const site = byHost(config, { app: createApp(deps, sets.app), pages });
  const publicApp: App = (request) =>
    WORKER_PATH.test(request.path) ? notFound(request) : site(request);
  return [
    { app: publicApp, port: config.port, host: config.host },
    { app: createApp(deps, sets.worker), port: config.internalPort, host: WORKER_HOST },
  ];
}

export interface RunningServer {
  deps: Deps;
  urls: string[];
  close(): Promise<void>;
}

/** A system code such as ECONNREFUSED or EADDRINUSE, or a Postgres SQLSTATE: never a value. */
const ERROR_CODE = /^[A-Za-z0-9_]{1,32}$/;

/**
 * What `main.ts` prints when start-up fails (S17): a configuration error names the variable; any
 * other error only its name and code, since a message can hold a connection string or key.
 */
export function startupFailure(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  if (!(error instanceof Error)) return "The server failed to start (unknown).";
  const code: unknown = Reflect.get(error, "code");
  const named = typeof code === "string" && ERROR_CODE.test(code) ? `, ${code}` : "";
  return `The server failed to start (${error.name}${named}).`;
}

/** Start the listeners and the sweeper (S1, S16). */
export async function startServer(
  config: Config,
  overrides: Partial<Deps> = {},
): Promise<RunningServer> {
  const deps = await buildDeps(config, overrides);
  const log = deps.log ?? stdoutLog;
  const servers: AppServer[] = [];
  try {
    for (const { app, port, host } of listenersFor(deps)) {
      servers.push(await listen(app, { port, host, log }));
    }
  } catch (error) {
    await Promise.all(servers.map((s) => s.close()));
    await deps.db.close();
    throw error;
  }
  const stopSweeper = startSweeper(deps, SWEEP_MS);
  return {
    deps,
    urls: servers.map((s) => s.url),
    async close() {
      stopSweeper();
      await Promise.all(servers.map((s) => s.close()));
      await deps.db.close();
    },
  };
}
