# M14f Wiring, Fly Runner, Deploy Files, Demo and End-to-End Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One entry point that runs the hosted server in production, development or demo mode; the Fly Machines runner; the container image, the worker's firewall entrypoint and the Fly app configs; `pnpm hosted:demo`; and an end-to-end test that drives the whole journey over HTTP.

**Architecture:** `packages/server/src/main.ts` turns `loadConfig(process.env)` into `Deps` and listeners. In production the worker's routes (`/internal/*`, `/llm/*`) listen on a second port that Fly's private network reaches and its public proxy does not, so a leaked job token is useless from the internet. Development and demo run one loopback listener. One Dockerfile builds a `server` and a `worker` target from the monorepo.

**Tech Stack:** TypeScript, `node:http`, Fly Machines REST API, Docker, nftables, `setpriv`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-repowiki-hosted-slice-design.md` (S1, S9, S16, S17, S18, §11, §13).

## Global Constraints

- Nothing is deployed and no Fly, GitHub or Anthropic endpoint is called by any test; the Fly runner is tested against a fake `fetch`.
- Production refuses to start without every variable `loadConfig` names (S17), and logs one JSON line per request with method, route pattern, status and duration only.
- The worker image's entrypoint runs phase 1 as root, then locks the network to the server's private address and port, then runs phase 2 as an unprivileged user with no new privileges.
- `hosted:demo` binds `127.0.0.1` only and needs no account, key or network.
- One branch per task, stacked on M14e: `m14/server-main`, `m14/deploy`, `m14/hosted-e2e`.

## Review Focus

1. **`/internal/*` or `/llm/*` reached through the public port in production**: 404. Pinned in Task 1.
2. **Phase 1 fails** (clone refused): the entrypoint stops before phase 2 and the firewall never opens anything. Pinned in Task 2.
3. **The Fly API refuses a machine**: the runner throws, the job stays queued, and the sweeper restarts it later (M14c's bound). Pinned in Task 1.
4. **A firewall rule allowing more than the server's address and port** (DNS, any other host): absent from the rendered rules. Pinned in Task 2.
5. **The demo journey with a page hidden**: the hidden page is absent from the published wiki. Pinned in Task 3.

## Amendments from the plan review (binding: where they conflict with a task below, they win)

- **A1 (Task 2, Important): the server image's writable paths.** `buildSite` creates `packages/site/.astro/` and Vite writes caches under `packages/site/node_modules/.vite`.
  - In the `server` target, before `USER node`, run `RUN mkdir -p packages/site/.astro packages/site/node_modules/.vite && chown -R node:node packages/site/.astro packages/site/node_modules/.vite`.
  - The test asserts the Dockerfile does that.
  - The migrations under `packages/server/src/db/migrations/` are in the image because the whole repository is copied; keep it that way.
- **A2 (Tasks 1 and 3, Important): no port 0.** `loadConfig` refuses `PORT=0`, and a 0 port would make the origin unusable for the Origin check and the worker.
  - Tests and the e2e reserve a free port first: listen on 0 with `node:net`, read the port, close it. Then pass the real port as `PORT`.
- **A3 (Task 1): real signatures.** Use `listen(app, { port, host })` and `fakeGitHubFetch(...)` exactly as M14a and M14b export them, and the actual name of the auth and landing route factories.
- **A4 (spec 3, recorded only): a separate content origin.** Public and preview sites share the app's origin. The CSP (`script-src 'self'`, no inline scripts) is the defence against an escaping bug in the site package. Moving pages to their own origin is spec 3's hardening. Add one line saying so to spec 2 §14 (Out of scope).

---

### Task 1: The entry point, two listeners and the Fly runner

**Files:**
- Create: `packages/server/src/runner/fly-runner.ts`, `packages/server/src/runner/fly-runner.test.ts`
- Create: `packages/server/src/wiring.ts`, `packages/server/src/wiring.test.ts`, `packages/server/src/main.ts`
- Modify: `packages/server/src/config.ts` (`internalPort`), `packages/server/src/config.test.ts`, `package.json` (root scripts), `packages/server/src/index.ts`

**Interfaces:**
- Consumes: every route factory from M14a–e (`authRoutes`, `projectRoutes`, `draftRoutes`, `previewRoutes`, `publishRoutes`, `internalRoutes`, `llmRoutes`, `publicRoutes`, and the landing page route), `createApp`, `listen`, `openDatabase`, `migrate`, the object store opener, `localRunner`, `startSweeper`, `fakeGitHubFetch`, `fakeAnthropicFetch`.
- Produces: `flyRunner({ apiToken, app, image, internalUrl, fetch?, engineVersion })` → `JobRunner`; `FLY_API` (`https://api.machines.dev/v1`); `buildDeps(config, overrides?)` → `Promise<Deps>`; `routeSets(deps)` → `{ public: Route[]; worker: Route[] }`; `startServer(config)` → `Promise<{ close(): Promise<void>; urls: string[] }>`; `Config.internalPort` (`INTERNAL_PORT`, default 8788, production only).

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-main
```

- [ ] **Step 2: Write the failing tests**

`packages/server/src/runner/fly-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FLY_API, flyRunner } from "./fly-runner.ts";

function fake(status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(status === 200 ? { id: "m1" } : { error: "no capacity" }), { status });
  };
  return { fetchFn, calls };
}

const options = {
  apiToken: "fly-secret",
  app: "repowiki-workers",
  image: "registry.fly.io/repowiki-workers:deployment-1",
  internalUrl: "http://repowiki.internal:8788",
  engineVersion: "abc1234",
};

describe("the Fly runner (spec 2 S16)", () => {
  it("creates one auto-destroying machine with only the job's environment", async () => {
    const { fetchFn, calls } = fake();
    await flyRunner({ ...options, fetch: fetchFn }).start({ jobId: "j1", attempt: 2, token: "job-token" });
    expect(calls[0]?.url).toBe(`${FLY_API}/apps/repowiki-workers/machines`);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer fly-secret");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.config).toMatchObject({
      image: options.image,
      auto_destroy: true,
      restart: { policy: "no" },
      metadata: { repowiki_job: "j1", repowiki_attempt: "2" },
    });
    expect(body.config.env).toEqual({
      REPOWIKI_API_URL: "http://repowiki.internal:8788",
      REPOWIKI_JOB_TOKEN: "job-token",
      REPOWIKI_WORKER_MODE: "engine",
      REPOWIKI_ENGINE_VERSION: "abc1234",
    });
    expect(JSON.stringify(body)).not.toContain("fly-secret");
  });

  it("throws when Fly refuses, without echoing the token", async () => {
    const { fetchFn } = fake(422);
    const start = flyRunner({ ...options, fetch: fetchFn }).start({ jobId: "j1", attempt: 1, token: "job-token" });
    await expect(start).rejects.toThrow("Fly refused the worker machine: HTTP 422");
    await expect(start).rejects.not.toThrow(/job-token|fly-secret/);
  });
});
```

`packages/server/src/wiring.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { buildDeps, routeSets } from "./wiring.ts";

const DEMO = { REPOWIKI_MODE: "demo", PORT: "0" };

describe("route sets (spec 2 S1)", () => {
  it("keeps the worker's routes off the public listener", async () => {
    const deps = await buildDeps(loadConfig(DEMO));
    const sets = routeSets(deps);
    const top = (routes: { pattern: string }[]) => new Set(routes.map((r) => r.pattern.split("/")[1]));
    expect(top(sets.public).has("internal")).toBe(false);
    expect(top(sets.public).has("llm")).toBe(false);
    expect([...top(sets.worker)].sort()).toEqual(["internal", "llm"]);
    expect(sets.public.at(-1)?.pattern).toBe("/:handle/:slug/*");
    await deps.db.close();
  });

  it("wires the demo with fakes for GitHub, the model and the worker", async () => {
    const deps = await buildDeps(loadConfig(DEMO));
    expect(deps.config.github.kind).toBe("fake");
    expect(deps.anthropic.url).toBe("https://api.anthropic.test");
    await deps.db.close();
  });
});
```

Append to `packages/server/src/config.test.ts` (inside the production `describe`, using that file's full production environment fixture, named `PRODUCTION` here):

```ts
  it("listens for workers on INTERNAL_PORT, 8788 by default", () => {
    expect(loadConfig(PRODUCTION).internalPort).toBe(8788);
    expect(loadConfig({ ...PRODUCTION, INTERNAL_PORT: "9000" }).internalPort).toBe(9000);
    expect(loadConfig({ REPOWIKI_MODE: "demo" }).internalPort).toBeNull();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/runner/fly-runner.test.ts packages/server/src/wiring.test.ts packages/server/src/config.test.ts`
Expected: FAIL — cannot resolve `./fly-runner.ts`, `./wiring.ts`; `internalPort` undefined.

- [ ] **Step 4: Write the implementation**

In `packages/server/src/config.ts`, add `internalPort: number | null;` to `Config`; in production parse `INTERNAL_PORT` (default 8788, same range check as `PORT`, and different from `PORT`); outside production set `null`.

`packages/server/src/runner/fly-runner.ts`:

```ts
import type { JobRunner } from "./runner.ts";

export const FLY_API = "https://api.machines.dev/v1";

/**
 * One auto-destroying Fly Machine per job attempt (spec 2 S16). Its environment is the job's
 * single-use token and the server's private address, nothing else.
 */
export function flyRunner(options: {
  apiToken: string;
  app: string;
  image: string;
  internalUrl: string;
  engineVersion: string;
  fetch?: typeof fetch;
}): JobRunner {
  const fetchFn = options.fetch ?? fetch;
  return {
    async start({ jobId, attempt, token }) {
      const response = await fetchFn(`${FLY_API}/apps/${encodeURIComponent(options.app)}/machines`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          config: {
            image: options.image,
            env: {
              REPOWIKI_API_URL: options.internalUrl,
              REPOWIKI_JOB_TOKEN: token,
              REPOWIKI_WORKER_MODE: "engine",
              REPOWIKI_ENGINE_VERSION: options.engineVersion,
            },
            guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
            auto_destroy: true,
            restart: { policy: "no" },
            metadata: { repowiki_job: jobId, repowiki_attempt: String(attempt) },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Fly refused the worker machine: HTTP ${response.status}`);
    },
  };
}
```

`packages/server/src/wiring.ts`:

```ts
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApp, type Deps } from "./app.ts";
import type { Config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { openDatabase } from "./db/db.ts";
import { fakeGitHubFetch } from "./github/fake.ts";
import type { Route } from "./http/router.ts";
import { listen } from "./http/server.ts";
import { openObjectStore } from "./objects/open.ts";
import { fakeAnthropicFetch } from "./proxy/fake-anthropic.ts";
import { authRoutes } from "./routes/auth.ts";
import { draftRoutes } from "./routes/drafts.ts";
import { internalRoutes } from "./routes/internal.ts";
import { llmRoutes } from "./routes/llm.ts";
import { previewRoutes } from "./routes/preview.ts";
import { projectRoutes } from "./routes/projects.ts";
import { publicRoutes } from "./routes/public.ts";
import { publishRoutes } from "./routes/publish.ts";
import { flyRunner } from "./runner/fly-runner.ts";
import { localRunner } from "./runner/local-runner.ts";
import { startSweeper } from "./runner/sweeper.ts";

const WORKER_ENTRY = fileURLToPath(new URL("../../worker/src/main.ts", import.meta.url));
const log = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

/** Every production seam, or its local stand-in in development and demo (spec 2 S17, S18). */
export async function buildDeps(config: Config, overrides: Partial<Deps> = {}): Promise<Deps> {
  const db = await openDatabase(config.database);
  await migrate(db);
  const fake = config.github.kind === "fake";
  const runner =
    config.runner.kind === "fly"
      ? flyRunner({ ...config.runner, engineVersion: process.env.REPOWIKI_ENGINE_VERSION ?? "dev" })
      : localRunner({
          workerEntry: WORKER_ENTRY,
          internalUrl: config.runner.internalUrl,
          mode: config.mode === "demo" ? "fixture" : "engine",
          log,
        });
  return {
    config,
    db,
    fetch: fake ? fakeGitHubFetch(config.origin) : fetch,
    github: /* M14b's endpoint set for config.github, e.g. */ (await import("./github/endpoints.ts")).endpointsFor(config),
    now: () => new Date().toISOString(),
    newId: randomUUID,
    runner,
    objects: openObjectStore(config.objects),
    anthropic:
      config.mode === "demo" || config.anthropicApiKey === null
        ? { url: "https://api.anthropic.test", key: config.mode === "demo" ? "demo" : null, fetch: fakeAnthropicFetch().fetch }
        : { url: "https://api.anthropic.com", key: config.anthropicApiKey, fetch },
    ...overrides,
  };
}

/** The public listener's routes, the worker listener's, and the order that keeps handles last. */
export function routeSets(deps: Deps): { public: Route[]; worker: Route[] } {
  return {
    public: [
      ...authRoutes(deps),
      ...projectRoutes(deps),
      ...draftRoutes(deps),
      ...previewRoutes(deps),
      ...publishRoutes(deps),
      ...publicRoutes(deps),
    ],
    worker: [...internalRoutes(deps), ...llmRoutes(deps)],
  };
}

/** Start the listeners and the sweeper; one loopback listener outside production (S1). */
export async function startServer(config: Config, overrides: Partial<Deps> = {}) {
  const deps = await buildDeps(config, overrides);
  const sets = routeSets(deps);
  const servers =
    config.internalPort === null
      ? [await listen(createApp(deps, [...sets.worker, ...sets.public]), config.port, config.host)]
      : [
          await listen(createApp(deps, sets.public), config.port, config.host),
          await listen(createApp(deps, sets.worker), config.internalPort, "::"),
        ];
  const stopSweeper = startSweeper(deps, 30_000, log);
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
```

(Match the real names from M14a–b: the landing page route if it is separate from `authRoutes`, `listen`'s signature and return value, `openObjectStore`, how `Deps.github` is built, and `fakeGitHubFetch`'s arguments. The `github:` line above is a placeholder for whatever M14b's `Deps.github` holds — replace it with the direct call; do not keep a dynamic import. Put the worker routes first on the single listener so `/internal/...` never reaches `/:handle/:slug/*`.)

`packages/server/src/main.ts`:

```ts
import { ConfigError, loadConfig } from "./config.ts";
import { startServer } from "./wiring.ts";

try {
  const config = loadConfig(process.env);
  const server = await startServer(config);
  process.stdout.write(`${JSON.stringify({ started: config.mode, urls: server.urls })}\n`);
  if (config.mode === "demo") {
    process.stdout.write(`RepoWiki demo: open ${config.origin}/ and sign in (no GitHub account needed).\n`);
  }
  const stop = () => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  process.stderr.write(`${error instanceof ConfigError ? error.message : "The server failed to start."}\n`);
  process.exit(1);
}
```

Root `package.json` scripts:

```json
    "hosted:serve": "node packages/server/src/main.ts",
    "hosted:dev": "REPOWIKI_MODE=development node --env-file-if-exists=.env packages/server/src/main.ts",
    "hosted:demo": "REPOWIKI_MODE=demo node packages/server/src/main.ts",
```

(If M14d already added `hosted:worker`, keep it. In demo mode the sign-up allowlist must admit the fake user: if `loadConfig` leaves it empty and sign-up refuses everyone, default it to `demo-dev` in demo mode and add that case to `config.test.ts`.)

Add to `packages/server/src/index.ts`:

```ts
export { FLY_API, flyRunner } from "./runner/fly-runner.ts";
export { buildDeps, routeSets, startServer } from "./wiring.ts";
```

- [ ] **Step 5: Run the tests, check, try the demo by hand and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server
pnpm check
(REPOWIKI_MODE=demo PORT=8799 node packages/server/src/main.ts & echo $! > /tmp/demo.pid; sleep 3; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8799/; kill "$(cat /tmp/demo.pid)")
git add packages/server package.json
git -c user.email=sean.may101@gmail.com commit -m "feat(server): wire the server's modes, keep worker routes off the public port, and start workers on Fly"
```

Expected from the curl: `200`. (Write the pid file to the scratchpad directory rather than `/tmp` when running this.)

---

### Task 2: The container image, the worker's firewall entrypoint and the Fly configs

**Files:**
- Create: `deploy/Dockerfile`, `deploy/worker-entrypoint.sh`, `deploy/fly.server.toml`, `deploy/fly.worker.toml`, `.dockerignore`
- Create: `scripts/deploy-files.test.ts`

**Interfaces:**
- Consumes: `packages/worker/src/main.ts` (`phase1`, `phase2`), `packages/server/src/main.ts`, the env names of `loadConfig`.
- Produces: the `server` and `worker` image targets; `worker-entrypoint.sh` (reads `REPOWIKI_API_URL`, `REPOWIKI_JOB_TOKEN`; writes `/work`); Fly app configs.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/deploy
```

- [ ] **Step 2: Write the failing test**

`scripts/deploy-files.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");

describe("the worker entrypoint (spec 2 S9)", () => {
  const script = read("deploy/worker-entrypoint.sh");

  it("is valid sh", () => {
    expect(spawnSync("sh", ["-n", `${ROOT}deploy/worker-entrypoint.sh`]).status).toBe(0);
  });

  it("runs phase 1, then the firewall, then phase 2 as the worker user with no new privileges", () => {
    const phase1 = script.indexOf("main.ts phase1");
    const firewall = script.indexOf("nft -f");
    const phase2 = script.indexOf("main.ts phase2");
    expect(phase1).toBeGreaterThan(0);
    expect(firewall).toBeGreaterThan(phase1);
    expect(phase2).toBeGreaterThan(firewall);
    expect(script).toMatch(/setpriv[^\n]*--no-new-privs/);
    expect(script).toMatch(/setpriv[^\n]*--reuid=worker/);
    expect(script).toContain("set -eu");
  });

  it("drops all output except loopback, replies, and the server's address and port", () => {
    const rules = script.slice(script.indexOf("nft -f"), script.indexOf("RULES", script.indexOf("nft -f") + 10));
    expect(rules).toContain("policy drop");
    expect(rules).toMatch(/ip6 daddr \$addr tcp dport \$port accept/);
    expect(rules).not.toMatch(/dport 53|udp/);
    expect(rules.match(/accept/g)?.length).toBe(5);
  });
});

describe("the image and the Fly configs (spec 2 §2)", () => {
  it("pins the Node and pnpm versions the repo uses", () => {
    const docker = read("deploy/Dockerfile");
    expect(docker).toMatch(/FROM node:24\.\d+\.\d+-bookworm-slim/);
    expect(docker).toContain("pnpm@10.");
    expect(docker).toMatch(/FROM base AS server/);
    expect(docker).toMatch(/FROM base AS worker/);
    expect(docker).toContain("nftables");
  });

  it("exposes only the public port on the server and no service on the worker app", () => {
    const server = read("deploy/fly.server.toml");
    expect(server).toContain("internal_port = 8787");
    expect(server).not.toContain("internal_port = 8788");
    expect(read("deploy/fly.worker.toml")).not.toContain("[[services]]");
    expect(read("deploy/fly.worker.toml")).not.toContain("[http_service]");
  });

  it("keeps secrets out of the image and the configs", () => {
    for (const path of ["deploy/Dockerfile", "deploy/fly.server.toml", "deploy/fly.worker.toml"]) {
      expect(read(path)).not.toMatch(/sk-ant|TOKEN_KEY\s*=|SECRET\s*=|DATABASE_URL\s*=/);
    }
    expect(read(".dockerignore")).toMatch(/^\.env$/m);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run scripts/deploy-files.test.ts`
Expected: FAIL — ENOENT on `deploy/worker-entrypoint.sh`.

- [ ] **Step 4: Write the files**

`deploy/Dockerfile` (use the exact Node 24 patch version from `.nvmrc`, `.node-version` or CI if one exists; otherwise the latest 24.x at least two weeks old):

```dockerfile
# Hosted RepoWiki (spec 2 §2): one image, two targets. Build from the repository root:
#   docker build -f deploy/Dockerfile --target server -t repowiki-server .
#   docker build -f deploy/Dockerfile --target worker -t repowiki-worker .
FROM node:24.11.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && rm -rf /root/.cache /root/.npm

FROM base AS server
ENV REPOWIKI_MODE=production NODE_ENV=production
USER node
EXPOSE 8787 8788
CMD ["node", "packages/server/src/main.ts"]

FROM base AS worker
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates nftables util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --shell /usr/sbin/nologin worker
COPY deploy/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
RUN chmod 0755 /usr/local/bin/worker-entrypoint
ENTRYPOINT ["/usr/local/bin/worker-entrypoint"]
```

(Set `pnpm@` to the exact version in the root `package.json`'s `packageManager` field.)

`deploy/worker-entrypoint.sh`:

```sh
#!/bin/sh
# The worker Machine's two phases (spec 2 S9). Phase 1 runs as root with the network open: lease
# the job and clone the public repository. Then the firewall allows only the server's private
# address and port, and phase 2 runs the engine as an unprivileged user with no new privileges.
set -eu
umask 077
WORK=/work
APP=/app/packages/worker/src/main.ts
mkdir -p "$WORK"
export REPOWIKI_WORK_DIR="$WORK"

host=$(printf '%s' "$REPOWIKI_API_URL" | sed -E 's#^https?://\[?([^]/:]+)\]?.*$#\1#')
port=$(printf '%s' "$REPOWIKI_API_URL" | sed -nE 's#^https?://(\[[^]]+\]|[^/:]+):([0-9]+).*$#\2#p')
[ -n "$port" ] || port=80
addr=$(getent ahostsv6 "$host" | awk 'NR == 1 { print $1 }')
[ -n "$addr" ] || { echo '{"worker":"cannot resolve the server"}' >&2; exit 1; }
# Phase 2 has no DNS: the server's name resolves from /etc/hosts.
printf '%s %s\n' "$addr" "$host" >> /etc/hosts

node "$APP" phase1

chown -R worker:worker "$WORK"
nft -f - <<RULES
flush ruleset
table inet sandbox {
  chain output {
    type filter hook output priority 0; policy drop;
    oif "lo" accept
    ct state established,related accept
    ip6 daddr $addr tcp dport $port accept
  }
  chain input {
    type filter hook input priority 0; policy drop;
    iif "lo" accept
    ct state established,related accept
  }
}
RULES

exec setpriv --reuid=worker --regid=worker --init-groups --no-new-privs --bounding-set=-all \
  env HOME=/home/worker node "$APP" phase2
```

`deploy/fly.server.toml`:

```toml
# The hosted server (spec 2 S1). Secrets are set with `fly secrets set`, never here.
app = "repowiki"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"
  build-target = "server"

[env]
  REPOWIKI_MODE = "production"
  PORT = "8787"
  INTERNAL_PORT = "8788"
  HOST = "0.0.0.0"

# Only the public port is a service; workers reach 8788 over the private network as
# http://repowiki.internal:8788 (INTERNAL_URL).
[http_service]
  internal_port = 8787
  force_https = true
  auto_stop_machines = "off"
  min_machines_running = 1

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    method = "GET"
    path = "/"

[[vm]]
  size = "shared-cpu-2x"
  memory = "2gb"
```

(The server's sweeper and in-memory render queue assume one machine; say so in a comment if Fly's default is two.)

`deploy/fly.worker.toml`:

```toml
# The worker app (spec 2 S9, S16). It has no services: the server creates one auto-destroying
# Machine per job attempt through the Machines API with this app's latest image.
app = "repowiki-workers"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"
  build-target = "worker"
```

`.dockerignore`:

```
.git
node_modules
**/node_modules
.env
.env.*
!.env.example
.repowiki
.superpowers
coverage
dist
packages/site/.astro
```

(`fly deploy` runs from the directory holding the toml, and `[build] dockerfile` resolves relative to it; the build context must be the repository root. If the runbook's `fly deploy --config deploy/fly.server.toml --dockerfile deploy/Dockerfile .` form needs the paths changed, change them here and in the test together.)

- [ ] **Step 5: Run the test, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run scripts/deploy-files.test.ts
pnpm check
git add deploy .dockerignore scripts/deploy-files.test.ts
git -c user.email=sean.may101@gmail.com commit -m "build(deploy): add the server and worker image, the worker's firewall entrypoint and the Fly configs"
```

---

### Task 3: The demo journey, end to end

**Files:**
- Create: `packages/server/src/e2e.test.ts`
- Modify: whatever the journey shows is broken (each fix with its own failing unit test first)

**Interfaces:**
- Consumes: `startServer`, `loadConfig` (demo mode), the fixture worker (M14d), every route.
- Produces: `e2e.test.ts`; a working `pnpm hosted:demo`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/hosted-e2e
```

- [ ] **Step 2: Write the test**

`packages/server/src/e2e.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { startServer } from "./wiring.ts";

/** A browser with one cookie jar, following no redirects on its own. */
function browser(base: string) {
  const jar = new Map<string, string>();
  async function go(path: string, init: { method?: string; form?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    let body: string | undefined;
    if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers.origin = base;
      body = new URLSearchParams(init.form).toString();
    }
    const response = await fetch(new URL(path, base), { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...value] = (pair ?? "").split("=");
      if (name) jar.set(name.trim(), value.join("="));
    }
    return { status: response.status, location: response.headers.get("location"), text: await response.text() };
  }
  /** Follow redirects on the same origin, up to 10. */
  async function follow(path: string, init: { form?: Record<string, string> } = {}) {
    let reply = await go(path, init);
    for (let hops = 0; hops < 10 && reply.location !== null; hops++) {
      const next = new URL(reply.location, base);
      if (next.origin !== new URL(base).origin) break;
      reply = await go(next.pathname + next.search);
    }
    return reply;
  }
  return { go, follow, jar };
}

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;

beforeAll(async () => {
  server = await startServer(loadConfig({ REPOWIKI_MODE: "demo", PORT: "0" }));
  base = server.urls[0] ?? "";
});
afterAll(async () => server.close());

describe("the hosted journey in demo mode (spec 2 §11, §13)", () => {
  it(
    "signs in, generates, edits, reviews, previews, publishes, reads signed out, and unpublishes",
    async () => {
      const me = browser(base);
      const dashboard = await me.follow("/auth/github");
      expect(dashboard.text).toContain("demo-dev/demo-repo");
      const csrf = csrfOf(dashboard.text);
      const created = await me.go("/projects", { form: { csrf, githubRepoId: field(dashboard.text, "githubRepoId") } });
      expect(created.status).toBe(303);
      const projectPath = created.location ?? "";

      let page = await me.go(projectPath);
      for (let i = 0; i < 60 && !page.text.includes("Portfolio (revision 1)"); i++) {
        await new Promise((r) => setTimeout(r, 500));
        page = await me.go(projectPath);
      }
      expect(page.text).toContain("Portfolio (revision 1)");

      const hidden = /name="hidden" value="([^"]+)"/.exec(page.text)?.[1] ?? "";
      const saved = await me.go(`${projectPath}/revisions`, {
        form: { csrf, baseRevision: "1", contribution: "I wrote the ingest code.", hidden },
      });
      expect(saved.status).toBe(303);
      expect((await me.go(`${projectPath}/review`, { form: { csrf, revision: "2", attest: "yes" } })).status).toBe(303);
      expect((await me.go(`${projectPath}/preview`, { form: { csrf, revision: "2" } })).status).toBe(303);
      page = await me.go(projectPath);
      const previewHash = field(page.text, "previewHash");
      expect(previewHash).toMatch(/^[0-9a-f]{64}$/);
      const published = await me.go(`${projectPath}/publish`, {
        form: { csrf, revision: "2", expectedVersion: "0", previewHash },
      });
      expect(published.status).toBe(303);

      const reader = browser(base);
      const project = await reader.go("/demo-dev/demo-repo");
      expect(project.status).toBe(200);
      expect(project.text).toContain("I wrote the ingest code.");
      expect(project.text).toContain("Citations resolve to commit");
      expect((await reader.go("/demo-dev/demo-repo/docs/")).status).toBe(200);
      expect((await reader.go(`/demo-dev/demo-repo/docs/wiki/${hidden}/`)).status).toBe(404);
      expect((await reader.go("/demo-dev")).text).toContain('href="/demo-dev/demo-repo"');

      expect((await me.go(`${projectPath}/unpublish`, { form: { csrf } })).status).toBe(303);
      expect((await reader.go("/demo-dev/demo-repo")).status).toBe(410);
    },
    300_000,
  );
});
```

(Adjust the sign-in flow to the fake GitHub M14b built: if `/auth/github` redirects to a fake authorize URL on the same origin, `follow` handles it; if it points at `github.com`, the demo's endpoints are wrong — fix them so the demo never leaves `127.0.0.1`.)

- [ ] **Step 3: Run it and fix what it finds**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/e2e.test.ts`
Expected: PASS once the journey works. Each failure it shows is a real defect: reproduce it with a unit test in the owning module first (TDD), fix it there, and rerun.

- [ ] **Step 4: Run the demo by hand once**

```bash
pnpm hosted:demo
```

Open the printed URL, click through the same journey, and confirm search and the diagram render on the published wiki (they need the CSP's `wasm-unsafe-eval` and inline styles). Stop it with Ctrl-C.

- [ ] **Step 5: Check and commit**

```bash
pnpm format && pnpm check
git add packages
git -c user.email=sean.may101@gmail.com commit -m "test(server): drive the whole hosted journey over HTTP in demo mode"
```
