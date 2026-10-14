# M14a Server Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start `packages/server`: configuration, the HTTP layer, the Postgres seam with its schema, and the account, handle and session store.

**Architecture:** `node:http` with a hand-written router (S2); a two-method `Db` seam with PGlite and `pg` adapters (S3); entity rows stored as Contract-validated `jsonb` beside key columns (S4); every mutation one transaction (S5); hashed session ids in a `__Host-` cookie with an Origin check and a CSRF token (S6).

**Tech Stack:** TypeScript (strict ESM, type stripping), zod 4.6.5, `pg` 8.23.1, `@electric-sql/pglite` 0.5.8, vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-repowiki-hosted-slice-design.md` (S-rulings, §5); Contract `2026-10-14-repowiki-hosted-contract-design.md`.

## Global Constraints

- Runtime deps of `packages/server`: `@repowiki/core`, `@repowiki/hosted`, `zod`, `pg`, `@electric-sql/pglite` (this plan); later plans add `@repowiki/site` and `@repowiki/llm`.
- Every body read from the database is parsed with its Contract schema (S4).
- No test touches the network; loopback servers on port 0 are fine.
- Exact pinned versions; `pnpm check` green before every commit; Conventional Commits scope `server`; author `sean.may101@gmail.com`.
- One branch per task, stacked: `m14/server-scaffold`, `m14/server-db`, `m14/server-accounts`.

## Review Focus

1. **A path with encoded slashes or dot segments** (`/a%2Fb`, `/../x`): the router must not match it as a different route. Pinned in Task 1.
2. **A body that lies about its length** (chunked, or `Content-Length` smaller than sent): the limit must still hold. Pinned in Task 1.
3. **Two sign-ins for the same new GitHub user at once**: one account, one handle. Pinned in Task 3.
4. **A login whose handle is taken by a tombstoned account**: the new account gets a suffix, never the tombstone. Pinned in Task 3.
5. **An expired session cookie replayed**: refused and deleted. Pinned in Task 3.

---

### Task 1: Package scaffold, configuration and the HTTP layer

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/src/config.ts`, `packages/server/src/config.test.ts`
- Create: `packages/server/src/http/router.ts`, `packages/server/src/http/router.test.ts`
- Create: `packages/server/src/http/body.ts`, `packages/server/src/http/server.ts`, `packages/server/src/http/server.test.ts`
- Modify: root `package.json` (devDependencies `"@repowiki/server": "workspace:*"`), `CLAUDE.md` (Layout line)

**Interfaces:**
- Produces: `Method`, `RouteRequest`, `Reply`, `Handler`, `Route`, `matchPattern(pattern, path)`, `createRouter(routes)`, `HttpError` (`status`, `message`), `readBody(raw, limit)`, `readJson(raw, schema, limit?)`, `readForm(raw, limit?)`, `BODY_LIMIT`, `SECURITY_HEADERS`, `listen(app, { port, host, log? }): Promise<AppServer>` (`url`, `close()`), `json(status, value)`, `text(status, body)`, `html(status, body)`, `redirect(location, status?)`; `Config`, `loadConfig(env)`, `ConfigError`.

- [ ] **Step 1: Branch and manifest**

```bash
git switch -c m14/server-scaffold
```

`packages/server/package.json`:

```json
{
  "name": "@repowiki/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@electric-sql/pglite": "0.5.8",
    "@repowiki/core": "workspace:*",
    "@repowiki/hosted": "workspace:*",
    "pg": "8.23.1",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/pg": "8.23.1"
  }
}
```

Add `"@repowiki/server": "workspace:*",` to the root devDependencies after `@repowiki/query`; run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

`packages/server/src/http/router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRouter, matchPattern, type Route } from "./router.ts";

describe("matchPattern (spec 2 S2)", () => {
  it("matches literals, named segments and a rest", () => {
    expect(matchPattern("/projects/:id", "/projects/abc")).toEqual({ id: "abc" });
    expect(matchPattern("/projects/:id", "/projects/abc/x")).toBeNull();
    expect(matchPattern("/:handle/:slug/*", "/sean/repowiki/wiki/a/b")).toEqual({
      handle: "sean",
      slug: "repowiki",
      "*": "wiki/a/b",
    });
    expect(matchPattern("/:handle/:slug/*", "/sean/repowiki")).toEqual({
      handle: "sean",
      slug: "repowiki",
      "*": "",
    });
    expect(matchPattern("/", "/")).toEqual({});
  });

  it("decodes segments but refuses an encoded slash, NUL or an empty segment", () => {
    expect(matchPattern("/u/:name", "/u/a%20b")).toEqual({ name: "a b" });
    expect(matchPattern("/u/:name", "/u/a%2Fb")).toBeNull();
    expect(matchPattern("/u/:name", "/u/a%00")).toBeNull();
    expect(matchPattern("/u/:name", "/u/")).toBeNull();
    expect(matchPattern("/u/:name", "/u/%E0%A4%A")).toBeNull();
    expect(matchPattern("/:a/*", "/x/a%2Fb")).toBeNull();
  });
});

describe("createRouter (spec 2 S2)", () => {
  const ok = async () => ({ status: 200 });
  const routes: Route[] = [
    { method: "GET", pattern: "/projects/:id", handler: ok },
    { method: "POST", pattern: "/projects", handler: ok },
    { method: "GET", pattern: "/:handle", handler: ok },
  ];
  const route = createRouter(routes);

  it("finds the first route whose method and pattern match", () => {
    expect(route("GET", "/projects/7")).toMatchObject({ params: { id: "7" } });
    expect(route("GET", "/sean")).toMatchObject({ params: { handle: "sean" } });
  });

  it("answers 405 for a known path with another method and 404 otherwise", () => {
    expect(route("DELETE", "/projects/7")).toEqual({ status: 405 });
    expect(route("GET", "/projects/7/x/y")).toEqual({ status: 404 });
  });
});
```

`packages/server/src/http/server.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BODY_LIMIT, HttpError, readForm, readJson } from "./body.ts";
import { createRouter, type RouteRequest } from "./router.ts";
import { type AppServer, html, json, listen } from "./server.ts";

const logs: object[] = [];
let server: AppServer;

beforeAll(async () => {
  const route = createRouter([
    { method: "GET", pattern: "/hello/:name", handler: async (r) => html(200, `hi ${r.params.name}`) },
    {
      method: "POST",
      pattern: "/json",
      handler: async (r) => json(200, await readJson(r.raw, z.strictObject({ n: z.int() }))),
    },
    {
      method: "POST",
      pattern: "/form",
      handler: async (r) => json(200, Object.fromEntries(await readForm(r.raw))),
    },
    {
      method: "GET",
      pattern: "/boom",
      handler: async () => {
        throw new Error("secret detail /etc/passwd");
      },
    },
    {
      method: "GET",
      pattern: "/teapot",
      handler: async () => {
        throw new HttpError(418, "short and stout");
      },
    },
  ]);
  server = await listen(
    async (request: RouteRequest) => {
      const found = route(request.method, request.path);
      if ("status" in found) return { status: found.status, body: "nope" };
      return found.handler({ ...request, params: found.params });
    },
    { port: 0, host: "127.0.0.1", log: (line) => logs.push(line) },
  );
});

afterAll(async () => server.close());

describe("listen (spec 2 S2)", () => {
  it("serves a route with the security headers", async () => {
    const response = await fetch(`${server.url}/hello/sean`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hi sean");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("answers HEAD like GET with no body", async () => {
    const response = await fetch(`${server.url}/hello/sean`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("refuses dot segments and doubled slashes before routing", async () => {
    const raw = await rawRequest("GET /hello/%2E%2E/boom HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(raw).toMatch(/^HTTP\/1\.1 404/);
    expect(await rawRequest("GET //hello/sean HTTP/1.1\r\nHost: x\r\n\r\n")).toMatch(/^HTTP\/1\.1 404/);
  });

  it("hides an unexpected error behind a generic 500 and logs only its name", async () => {
    const response = await fetch(`${server.url}/boom`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("passwd");
    expect(JSON.stringify(logs)).not.toContain("passwd");
    expect(logs.at(-1)).toMatchObject({ method: "GET", route: "/boom", status: 500, error: "Error" });
  });

  it("answers an HttpError with its status and message", async () => {
    const response = await fetch(`${server.url}/teapot`);
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("short and stout");
  });
});

describe("bodies (spec 2 S2)", () => {
  const post = (path: string, body: string, type: string) =>
    fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": type }, body });

  it("reads JSON that its schema accepts", async () => {
    const response = await post("/json", '{"n":3}', "application/json");
    expect(await response.json()).toEqual({ n: 3 });
  });

  it("refuses a wrong type, malformed JSON, a schema miss and an unknown field", async () => {
    expect((await post("/json", '{"n":3}', "text/plain")).status).toBe(415);
    expect((await post("/json", "{", "application/json")).status).toBe(400);
    expect((await post("/json", '{"n":"x"}', "application/json")).status).toBe(400);
    const unknown = await post("/json", '{"n":3,"admin":true}', "application/json");
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("admin");
  });

  it("refuses a body over the limit, declared or streamed", async () => {
    const big = `{"n":1,"pad":"${"x".repeat(BODY_LIMIT)}"}`;
    expect((await post("/json", big, "application/json")).status).toBe(413);
    const chunked = await rawRequest(
      `POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${(BODY_LIMIT + 10).toString(16)}\r\n${"x".repeat(BODY_LIMIT + 10)}\r\n0\r\n\r\n`,
    );
    expect(chunked).toMatch(/^HTTP\/1\.1 413/);
  });

  it("reads a urlencoded form", async () => {
    const response = await post("/form", "a=1&b=two", "application/x-www-form-urlencoded");
    expect(await response.json()).toEqual({ a: "1", b: "two" });
  });
});

/** One raw HTTP/1.1 exchange, for requests fetch normalises away. */
async function rawRequest(request: string): Promise<string> {
  const { connect } = await import("node:net");
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), "127.0.0.1", () => socket.end(request));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}
```

`packages/server/src/config.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server`
Expected: FAIL — cannot resolve `./router.ts`, `./server.ts`, `./body.ts`, `./config.ts`.

- [ ] **Step 4: Write the implementation**

`packages/server/src/http/router.ts`:

```ts
import type { IncomingMessage } from "node:http";

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "DELETE";

export interface RouteRequest {
  method: Method;
  path: string;
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  raw: IncomingMessage;
}

export interface Reply {
  status: number;
  /** A header with several values (Set-Cookie) takes an array. */
  headers?: Readonly<Record<string, string | string[]>>;
  body?: string | Uint8Array;
}

export type Handler = (request: RouteRequest) => Promise<Reply>;

export interface Route {
  method: Method;
  pattern: string;
  handler: Handler;
}

/** A decoded path segment, or null when it is empty, malformed, or hides a "/" or NUL. */
function decode(segment: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return value === "" || value.includes("/") || value.includes("\0") ? null : value;
}

/**
 * `pattern`'s parameters for `path`: `:name` takes one segment, a final `*` takes the rest
 * (possibly empty). Null when the path does not match.
 */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const want = pattern === "/" ? [] : pattern.split("/").slice(1);
  const have = path === "/" ? [] : path.split("/").slice(1);
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    if (part === "*") {
      const rest = have.slice(i);
      const decoded = rest.map((s) => (s === "" ? "" : decode(s)));
      if (decoded.some((s) => s === null)) return null;
      params["*"] = decoded.join("/");
      return params;
    }
    const segment = have[i];
    if (segment === undefined) return null;
    if (part.startsWith(":")) {
      const value = decode(segment);
      if (value === null) return null;
      params[part.slice(1)] = value;
    } else if (part !== segment) {
      return null;
    }
  }
  return have.length === want.length ? params : null;
}

export type Found = { handler: Handler; params: Record<string, string> } | { status: 404 | 405 };

/** The first route matching method and path; 405 when only the method differs, else 404. */
export function createRouter(routes: readonly Route[]): (method: string, path: string) => Found {
  return (method, path) => {
    let pathMatched = false;
    for (const route of routes) {
      const params = matchPattern(route.pattern, path);
      if (params === null) continue;
      pathMatched = true;
      const wanted = method === "HEAD" ? "GET" : method;
      if (route.method === wanted) return { handler: route.handler, params };
    }
    return { status: pathMatched ? 405 : 404 };
  };
}
```

`packages/server/src/http/body.ts`:

```ts
import type { IncomingMessage } from "node:http";
import type { z } from "zod";

export const BODY_LIMIT = 65_536;

/** An error a handler means the client to see, with its status and message. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The request body, refused with 413 past `limit` whether declared or streamed. */
export async function readBody(raw: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(raw.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    raw.resume();
    throw new HttpError(413, "Request body too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of raw) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      raw.resume();
      throw new HttpError(413, "Request body too large.");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function contentType(raw: IncomingMessage): string {
  return (raw.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** A JSON body its schema accepts; 415, 400 or 413 otherwise. */
export async function readJson<T>(
  raw: IncomingMessage,
  schema: z.ZodType<T>,
  limit = BODY_LIMIT,
): Promise<T> {
  if (contentType(raw) !== "application/json") {
    throw new HttpError(415, "Expected application/json.");
  }
  const text = (await readBody(raw, limit)).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Malformed JSON.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "body";
    const keys = issue && "keys" in issue ? ` (${(issue.keys as string[]).join(", ")})` : "";
    throw new HttpError(400, `${where}: ${issue?.message ?? "invalid"}${keys}`);
  }
  return parsed.data;
}

/** A urlencoded form body; 415 or 413 otherwise. */
export async function readForm(raw: IncomingMessage, limit = BODY_LIMIT): Promise<URLSearchParams> {
  if (contentType(raw) !== "application/x-www-form-urlencoded") {
    throw new HttpError(415, "Expected a form.");
  }
  return new URLSearchParams((await readBody(raw, limit)).toString("utf8"));
}
```

`packages/server/src/http/server.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HttpError } from "./body.ts";
import type { Method, Reply, RouteRequest } from "./router.ts";

/** Sent on every response; a handler may override the CSP for pages that need it (spec 2 S2). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

export type App = (request: RouteRequest) => Promise<Reply>;

export interface AppServer {
  url: string;
  close(): Promise<void>;
}

const METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]);

export function json(status: number, value: unknown, headers: Record<string, string> = {}): Reply {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(value),
  };
}

export function text(status: number, body: string): Reply {
  return { status, headers: { "content-type": "text/plain; charset=utf-8" }, body };
}

export function html(status: number, body: string, headers: Record<string, string> = {}): Reply {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body };
}

export function redirect(location: string, status = 303): Reply {
  return { status, headers: { location } };
}

/** A path the router may see: absolute, no empty segment, no "." or ".." even when encoded. */
function routablePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const segments = path.split("/").slice(1);
  return segments.every((segment, i) => {
    if (segment === "" && i !== segments.length - 1) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return decoded !== "." && decoded !== "..";
  });
}

async function respond(app: App, raw: IncomingMessage, res: ServerResponse, log: (line: object) => void) {
  const started = Date.now();
  const method = (raw.method ?? "GET").toUpperCase();
  const url = new URL(raw.url ?? "/", "http://server.invalid");
  let reply: Reply;
  let error: string | undefined;
  if (!METHODS.has(method)) {
    reply = text(405, "Method not allowed.");
  } else if (!routablePath(url.pathname)) {
    reply = text(404, "Not found.");
  } else {
    try {
      reply = await app({
        method: method as Method,
        path: url.pathname,
        params: {},
        query: url.searchParams,
        headers: raw.headers,
        raw,
      });
    } catch (e) {
      if (e instanceof HttpError) {
        reply = text(e.status, e.message);
      } else {
        error = e instanceof Error ? e.name : "unknown";
        reply = text(500, "Something went wrong.");
      }
    }
  }
  res.writeHead(reply.status, { ...SECURITY_HEADERS, ...reply.headers });
  res.end(method === "HEAD" ? undefined : reply.body);
  log({
    method,
    route: url.pathname,
    status: reply.status,
    ms: Date.now() - started,
    ...(error === undefined ? {} : { error }),
  });
}

/** Serve `app` on host:port (0 for any free port). */
export async function listen(
  app: App,
  options: { port: number; host: string; log?: (line: object) => void },
): Promise<AppServer> {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  const server = createServer((raw, res) => {
    void respond(app, raw, res, log);
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    url: `http://${options.host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

`packages/server/src/config.ts`:

```ts
import { Origin } from "@repowiki/hosted";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

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
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigError("PORT is invalid.");

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
```

`packages/server/src/index.ts`:

```ts
export { type Config, ConfigError, loadConfig, type Mode } from "./config.ts";
export { BODY_LIMIT, HttpError, readBody, readForm, readJson } from "./http/body.ts";
export {
  createRouter,
  type Found,
  type Handler,
  type Method,
  matchPattern,
  type Reply,
  type Route,
  type RouteRequest,
} from "./http/router.ts";
export {
  type App,
  type AppServer,
  html,
  json,
  listen,
  redirect,
  SECURITY_HEADERS,
  text,
} from "./http/server.ts";
```

`CLAUDE.md` Layout, after the `packages/hosted` line:

```markdown
- `packages/server` — the hosted web app, the worker's internal API and the LLM proxy (spec 2 `2026-10-14-repowiki-hosted-slice-design.md`): `node:http`, Postgres through `Db` (PGlite in tests and dev), every rule a call into `@repowiki/hosted`
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm format && node node_modules/vitest/vitest.mjs run packages/server`
Expected: PASS.

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add package.json pnpm-lock.yaml CLAUDE.md packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): add the server package with configuration and the HTTP layer"
```

---

### Task 2: The database seam, migrations and schema

**Files:**
- Create: `packages/server/src/db/db.ts`, `packages/server/src/db/pglite.ts`, `packages/server/src/db/pg.ts`
- Create: `packages/server/src/db/migrate.ts`, `packages/server/src/db/migrations/0001-initial.sql`
- Create: `packages/server/src/db/db.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces: `Queryable` (`query<R>(sql, params?): Promise<R[]>`, `exec(sql): Promise<void>`), `Db` (`Queryable` + `transaction(fn)`, `close()`), `withRetries(run, attempts?)`, `openPglite(dataDir: string | null): Promise<Db>`, `openPg(url): Db`, `migrationFiles()`, `migrate(db): Promise<number[]>`, `openDatabase(config.database): Promise<Db>` (opens and migrates), `isUniqueViolation(error)`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-db
```

- [ ] **Step 2: Write the failing tests**

`packages/server/src/db/db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./db.ts";
import { isUniqueViolation, withRetries } from "./db.ts";
import { migrate, migrationFiles } from "./migrate.ts";
import { openPglite } from "./pglite.ts";

let db: Db;
beforeAll(async () => {
  db = await openPglite(null);
});
afterAll(async () => db.close());

describe("migrations (spec 2 S4)", () => {
  it("are numbered from 1 with no gaps", () => {
    const files = migrationFiles();
    expect(files.map((f) => f.version)).toEqual(files.map((_, i) => i + 1));
    expect(files[0]?.name).toBe("0001-initial.sql");
  });

  it("apply once, then are a no-op", async () => {
    expect(await migrate(db)).toEqual(migrationFiles().map((f) => f.version));
    expect(await migrate(db)).toEqual([]);
    const tables = await db.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(tables.map((t) => t.name)).toEqual([
      "accounts",
      "audit_events",
      "generations",
      "github_tokens",
      "handles",
      "job_specs",
      "job_tokens",
      "jobs",
      "previews",
      "projects",
      "published_versions",
      "repositories",
      "reservations",
      "reviews",
      "revisions",
      "schema_migrations",
      "sessions",
    ]);
  });
});

describe("constraints (spec 2 §5)", () => {
  const P = "00000000-0000-4000-8000-0000000000a1";
  const J1 = "00000000-0000-4000-8000-0000000000b1";
  const J2 = "00000000-0000-4000-8000-0000000000b2";

  it("allow one non-terminal job per project, and any number of finished ones", async () => {
    const insert = (id: string, status: string) =>
      db.query(
        "INSERT INTO jobs (id, project_id, status, lease_expires_at, body) VALUES ($1, $2, $3, NULL, '{}'::jsonb)",
        [id, P, status],
      );
    await insert(J1, "queued");
    const error = await insert(J2, "running").catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    await db.query("UPDATE jobs SET status = 'failed' WHERE id = $1", [J1]);
    await insert(J2, "running");
  });

  it("roll a transaction back when it throws", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO repositories (github_repo_id, body) VALUES (1, '{}'::jsonb)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query("SELECT * FROM repositories")).toEqual([]);
  });
});

describe("withRetries (spec 2 S5)", () => {
  it("retries a serialization failure or deadlock, and nothing else", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("conflict"), { code: "40001" });
      return "done";
    };
    expect(await withRetries(flaky)).toBe("done");
    expect(calls).toBe(3);
    calls = 0;
    const broken = async () => {
      calls++;
      throw Object.assign(new Error("bad"), { code: "23505" });
    };
    await expect(withRetries(broken)).rejects.toThrow("bad");
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/db`
Expected: FAIL — cannot resolve `./db.ts`.

- [ ] **Step 4: Write the implementation**

`packages/server/src/db/db.ts`:

```ts
/** Run SQL with positional parameters; rows come back as plain objects, `jsonb` already parsed. */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  /** Several statements with no parameters, such as a migration. */
  exec(sql: string): Promise<void>;
}

/** Postgres, through `pg` in production or PGlite in tests and development (spec 2 S3). */
export interface Db extends Queryable {
  /** `fn` in one transaction: committed when it returns, rolled back when it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const RETRYABLE: ReadonlySet<string> = new Set(["40001", "40P01"]);

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** `run` again after a serialization failure or deadlock, up to `attempts` times in all. */
export async function withRetries<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(codeOf(error) ?? "")) throw error;
    }
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return codeOf(error) === "23505";
}
```

`packages/server/src/db/pglite.ts`:

```ts
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { type Db, type Queryable, withRetries } from "./db.ts";

function queryable(target: PGlite | Transaction): Queryable {
  return {
    query: async <R extends object>(sql: string, params: readonly unknown[] = []) =>
      (await target.query<R>(sql, [...params])).rows,
    exec: async (sql: string) => {
      await target.exec(sql);
    },
  };
}

/** Postgres in WASM, in memory (`null`) or under `dataDir` (spec 2 S3). */
export async function openPglite(dataDir: string | null): Promise<Db> {
  const pg = dataDir === null ? new PGlite() : new PGlite(dataDir);
  await pg.waitReady;
  return {
    ...queryable(pg),
    transaction: (fn) => withRetries(() => pg.transaction((tx) => fn(queryable(tx)))),
    close: () => pg.close(),
  };
}
```

`packages/server/src/db/pg.ts`:

```ts
import pg from "pg";
import { type Db, type Queryable, withRetries } from "./db.ts";

function queryable(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    query: async <R extends object>(sql: string, params: readonly unknown[] = []) =>
      (await client.query(sql, [...params])).rows as R[],
    exec: async (sql: string) => {
      await client.query(sql);
    },
  };
}

/** Postgres over the network (Neon in production, spec 2 S3). */
export function openPg(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    ...queryable(pool),
    transaction: (fn) =>
      withRetries(async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await fn(queryable(client));
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }),
    close: () => pool.end(),
  };
}
```

`packages/server/src/db/migrate.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { Db } from "./db.ts";
import { openPg } from "./pg.ts";
import { openPglite } from "./pglite.ts";

const DIR = new URL("./migrations/", import.meta.url);
const FILE = /^(\d{4})-[a-z0-9-]+\.sql$/;
/** Held for the length of a migration run, so two servers starting at once take turns. */
const LOCK = 727_001;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Every migration file in order; versions must run 1, 2, 3, … with no gap. */
export function migrationFiles(): Migration[] {
  const files = readdirSync(DIR)
    .filter((name) => FILE.test(name))
    .sort()
    .map((name) => ({
      version: Number(FILE.exec(name)?.[1]),
      name,
      sql: readFileSync(new URL(name, DIR), "utf8"),
    }));
  files.forEach((file, i) => {
    if (file.version !== i + 1) throw new Error(`migration ${file.name} is out of sequence`);
  });
  return files;
}

/** Apply every migration not yet applied, in one transaction; returns the versions applied. */
export async function migrate(db: Db): Promise<number[]> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  return db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(${LOCK})`);
    const rows = await tx.query<{ version: number }>("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((r) => r.version));
    const applied: number[] = [];
    for (const migration of migrationFiles()) {
      if (done.has(migration.version)) continue;
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
      applied.push(migration.version);
    }
    return applied;
  });
}

/** The configured database, migrated. */
export async function openDatabase(database: Config["database"]): Promise<Db> {
  const db = database.kind === "postgres" ? openPg(database.url) : await openPglite(database.dataDir);
  await migrate(db);
  return db;
}
```

`packages/server/src/db/migrations/0001-initial.sql`:

```sql
-- Hosted RepoWiki, spec 2 §5. Every table keeps its Contract entity in `body`; the other columns
-- exist for keys, lookups and constraints. A shipped migration is never edited; append one.

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  github_user_id bigint NOT NULL UNIQUE,
  body jsonb NOT NULL
);

CREATE TABLE handles (
  handle text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  body jsonb NOT NULL
);
CREATE INDEX handles_account ON handles (account_id);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  csrf text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_account ON sessions (account_id);

CREATE TABLE github_tokens (
  account_id uuid PRIMARY KEY REFERENCES accounts (id),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL
);

CREATE TABLE repositories (
  github_repo_id bigint PRIMARY KEY,
  body jsonb NOT NULL
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  github_repo_id bigint NOT NULL,
  slug text NOT NULL,
  body jsonb NOT NULL,
  UNIQUE (account_id, github_repo_id),
  UNIQUE (account_id, slug)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  status text NOT NULL,
  lease_expires_at timestamptz,
  body jsonb NOT NULL
);
CREATE UNIQUE INDEX jobs_one_active ON jobs (project_id) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_project ON jobs (project_id);

CREATE TABLE job_tokens (
  token_hash text PRIMARY KEY,
  job_id uuid NOT NULL,
  attempt int NOT NULL,
  issued_at timestamptz NOT NULL
);

-- What a worker needs that the Contract's Job does not hold: repository, author commits, export.
CREATE TABLE job_specs (
  job_id uuid PRIMARY KEY,
  body jsonb NOT NULL
);
CREATE INDEX job_tokens_job ON job_tokens (job_id);

CREATE TABLE generations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  body jsonb NOT NULL
);

CREATE TABLE revisions (
  project_id uuid NOT NULL,
  number int NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (project_id, number)
);

CREATE TABLE reviews (
  project_id uuid NOT NULL,
  revision int NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (project_id, revision)
);

CREATE TABLE previews (
  project_id uuid NOT NULL,
  revision int NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (project_id, revision)
);

CREATE TABLE published_versions (
  project_id uuid NOT NULL,
  version int NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (project_id, version)
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  attempt int NOT NULL,
  batch_id text,
  usd_micros bigint NOT NULL,
  settled boolean NOT NULL DEFAULT false
);
CREATE INDEX reservations_job ON reservations (job_id) WHERE NOT settled;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  body jsonb NOT NULL
);
```

Add to `packages/server/src/index.ts`:

```ts
export { type Db, isUniqueViolation, type Queryable, withRetries } from "./db/db.ts";
export { type Migration, migrate, migrationFiles, openDatabase } from "./db/migrate.ts";
export { openPg } from "./db/pg.ts";
export { openPglite } from "./db/pglite.ts";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm format && node node_modules/vitest/vitest.mjs run packages/server`
Expected: PASS.

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): add the Postgres seam, migrations and the initial schema"
```

---

### Task 3: Accounts, handles and sessions

**Files:**
- Create: `packages/server/src/crypto.ts`, `packages/server/src/crypto.test.ts`
- Create: `packages/server/src/http/cookies.ts`, `packages/server/src/http/cookies.test.ts`
- Create: `packages/server/src/store/rows.ts`, `packages/server/src/store/accounts.ts`, `packages/server/src/store/sessions.ts`, `packages/server/src/store/audit.ts`
- Create: `packages/server/src/store/accounts.test.ts`, `packages/server/src/store/test-db.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `Db`, `Queryable`, `migrate`, `openPglite`, `isUniqueViolation` (Task 2); from `@repowiki/hosted`: `Account`, `Handle`, `handleFor`, `lookupHandle`, `HandleRecord`, `AuditEvent`.
- Produces: `randomToken()`, `sha256Hex(text)`, `safeEqual(a, b)`; `parseCookies(header)`, `serializeCookie(name, value, options)`, `sessionCookieName(secure)`; `parsedBody(schema, body, what)`, `StoreError`; `GitHubProfile`, `signIn(db, profile, { newAccountId, allowNew, now })` → `{ account, handle, created } | null`, `accountById(db, id)`, `activeHandle(tx, accountId)`, `resolveHandle(tx, name)`; `createSession(db, accountId, now)` → `{ token, csrf, expiresAt }`, `readSession(db, token, now)` → `{ account, csrf } | null`, `endSession(db, token)`, `SESSION_DAYS`; `appendAudit(tx, event)`; test-only `freshDb()`.

- [ ] **Step 1: Branch**

```bash
git switch -c m14/server-accounts
```

- [ ] **Step 2: Write the failing tests**

`packages/server/src/store/test-db.ts`:

```ts
import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { openPglite } from "../db/pglite.ts";

/** Test-only: a migrated in-memory database. */
export async function freshDb(): Promise<Db> {
  const db = await openPglite(null);
  await migrate(db);
  return db;
}
```

`packages/server/src/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { randomToken, safeEqual, sha256Hex } from "./crypto.ts";

describe("crypto helpers (spec 2 S6)", () => {
  it("makes 32-byte url-safe tokens that differ", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  it("hashes with SHA-256 and compares in constant time", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("same", "diff")).toBe(false);
    expect(safeEqual("short", "longer")).toBe(false);
  });
});
```

`packages/server/src/http/cookies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCookies, serializeCookie, sessionCookieName } from "./cookies.ts";

describe("cookies (spec 2 S6)", () => {
  it("parse a Cookie header, first value winning", () => {
    expect(parseCookies("a=1; b=two%20words; a=3; bad")).toEqual(
      new Map([
        ["a", "1"],
        ["b", "two words"],
      ]),
    );
    expect(parseCookies(undefined)).toEqual(new Map());
  });

  it("serialize a secure session cookie and a loopback one", () => {
    expect(
      serializeCookie("__Host-session", "tok", { maxAgeSeconds: 60, secure: true, httpOnly: true }),
    ).toBe("__Host-session=tok; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure");
    expect(serializeCookie("session", "", { maxAgeSeconds: 0, secure: false, httpOnly: true })).toBe(
      "session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly",
    );
    expect(sessionCookieName(true)).toBe("__Host-session");
    expect(sessionCookieName(false)).toBe("session");
  });
});
```

`packages/server/src/store/accounts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import { activeHandle, resolveHandle, signIn, type GitHubProfile } from "./accounts.ts";
import { createSession, endSession, readSession } from "./sessions.ts";
import { freshDb } from "./test-db.ts";

const T0 = "2026-10-14T12:00:00.000Z";
const A1 = "00000000-0000-4000-8000-000000000001";
const A2 = "00000000-0000-4000-8000-000000000002";
const sean: GitHubProfile = {
  githubUserId: 101,
  login: "SeanPatrickMay",
  displayName: "Sean May",
  githubCreatedAt: "2019-01-01T00:00:00Z",
};
const yes = () => true;

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(async () => db.close());

describe("signIn (spec 2 S7)", () => {
  it("creates a Free account and its handle on first sign-in", async () => {
    const result = await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    expect(result).toMatchObject({
      created: true,
      handle: "seanpatrickmay",
      account: { id: A1, githubUserId: 101, login: "SeanPatrickMay", plan: "free", status: "active" },
    });
  });

  it("returns the same account and refreshes its cached login later", async () => {
    await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    const again = await signIn(
      db,
      { ...sean, login: "SeanMay", displayName: "S. May" },
      { newAccountId: A2, allowNew: () => false, now: T0 },
    );
    expect(again).toMatchObject({
      created: false,
      handle: "seanpatrickmay",
      account: { id: A1, login: "SeanMay", displayName: "S. May" },
    });
  });

  it("refuses a new account the allowlist does not name", async () => {
    expect(await signIn(db, sean, { newAccountId: A1, allowNew: () => false, now: T0 })).toBeNull();
    expect(await db.query("SELECT * FROM accounts")).toEqual([]);
  });

  it("suffixes a handle another account holds, even a tombstoned one", async () => {
    await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    await db.query("UPDATE handles SET body = jsonb_set(body, '{state}', '\"tombstoned\"')");
    const twin = { ...sean, githubUserId: 202, login: "seanpatrickmay" };
    const result = await signIn(db, twin, { newAccountId: A2, allowNew: yes, now: T0 });
    expect(result?.handle).toBe("seanpatrickmay-2");
  });

  it("makes one account when the same new user signs in twice at once", async () => {
    const [a, b] = await Promise.all([
      signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 }),
      signIn(db, sean, { newAccountId: A2, allowNew: yes, now: T0 }),
    ]);
    expect(a?.account.id).toBe(b?.account.id);
    expect(await db.query("SELECT * FROM accounts")).toHaveLength(1);
    expect(await db.query("SELECT * FROM handles")).toHaveLength(1);
  });

  it("resolves a handle and finds an account's active one", async () => {
    await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
    expect(await resolveHandle(db, "seanpatrickmay")).toEqual({
      kind: "active",
      accountId: A1,
      handle: "seanpatrickmay",
    });
    expect(await resolveHandle(db, "nobody")).toEqual({ kind: "missing" });
    expect(await activeHandle(db, A1)).toBe("seanpatrickmay");
  });
});

describe("sessions (spec 2 S6)", () => {
  beforeEach(async () => {
    await signIn(db, sean, { newAccountId: A1, allowNew: yes, now: T0 });
  });

  it("are stored only as a hash and read back with their CSRF token", async () => {
    const { token, csrf, expiresAt } = await createSession(db, A1, T0);
    expect(expiresAt).toBe("2026-11-13T12:00:00.000Z");
    const rows = await db.query<{ id_hash: string }>("SELECT id_hash FROM sessions");
    expect(rows[0]?.id_hash).not.toBe(token);
    expect(await readSession(db, token, T0)).toMatchObject({ account: { id: A1 }, csrf });
    expect(await readSession(db, "forged", T0)).toBeNull();
  });

  it("refuse and delete an expired session, and slide a live one", async () => {
    const { token } = await createSession(db, A1, T0);
    expect(await readSession(db, token, "2026-11-01T00:00:00.000Z")).not.toBeNull();
    const rows = await db.query<{ expires_at: Date }>("SELECT expires_at FROM sessions");
    expect(rows[0]?.expires_at.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(await readSession(db, token, "2027-01-01T00:00:00.000Z")).toBeNull();
    expect(await db.query("SELECT * FROM sessions")).toEqual([]);
  });

  it("end on sign-out", async () => {
    const { token } = await createSession(db, A1, T0);
    await endSession(db, token);
    expect(await readSession(db, token, T0)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server`
Expected: FAIL — cannot resolve `./crypto.ts`, `./cookies.ts`, `./accounts.ts`, `./sessions.ts`.

- [ ] **Step 4: Write the implementation**

`packages/server/src/crypto.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url: session ids, CSRF tokens, job tokens. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Constant-time equality for secrets of any length. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(sha256Hex(a), "hex");
  const y = Buffer.from(sha256Hex(b), "hex");
  return timingSafeEqual(x, y) && a.length === b.length;
}
```

`packages/server/src/http/cookies.ts`:

```ts
/** The cookies of a Cookie header; the first value of a repeated name wins. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (cookies.has(name)) continue;
    let value = part.slice(at + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    cookies.set(name, value);
  }
  return cookies;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
  httpOnly: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAgeSeconds}`,
    "SameSite=Lax",
    ...(options.httpOnly ? ["HttpOnly"] : []),
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/** `__Host-` binds the cookie to our origin; loopback development cannot set Secure (S6). */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-session" : "session";
}
```

`packages/server/src/store/rows.ts`:

```ts
import type { z } from "zod";

export class StoreError extends Error {}

/** A stored body parsed with its Contract schema; a body that fails is corruption, not input. */
export function parsedBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new StoreError(`stored ${what} is invalid`);
  return parsed.data;
}

export const asJson = (value: unknown) => JSON.stringify(value);
```

`packages/server/src/store/audit.ts`:

```ts
import { AuditEvent } from "@repowiki/hosted";
import type { Queryable } from "../db/db.ts";
import { asJson, parsedBody } from "./rows.ts";

export async function appendAudit(tx: Queryable, event: AuditEvent): Promise<void> {
  const body = parsedBody(AuditEvent, event, "audit event");
  await tx.query("INSERT INTO audit_events (id, created_at, body) VALUES ($1, $2, $3::jsonb)", [
    body.id,
    body.createdAt,
    asJson(body),
  ]);
}
```

`packages/server/src/store/accounts.ts`:

```ts
import {
  Account,
  Handle,
  type HandleLookup,
  type HandleRecord,
  handleFor,
  lookupHandle,
} from "@repowiki/hosted";
import { type Db, isUniqueViolation, type Queryable } from "../db/db.ts";
import { asJson, parsedBody } from "./rows.ts";

export interface GitHubProfile {
  githubUserId: number;
  login: string;
  displayName: string;
  githubCreatedAt: string;
}

export interface SignInOptions {
  newAccountId: string;
  /** Whether a GitHub login with no account yet may create one (the sign-up allowlist, S7). */
  allowNew: (login: string) => boolean;
  now: string;
}

export interface SignedIn {
  account: Account;
  handle: string;
  created: boolean;
}

/**
 * The account for a GitHub user, created with its handle on first sign-in (Contract §9). Null when
 * the user is new and not allowed to sign up. Two concurrent first sign-ins make one account.
 */
export async function signIn(
  db: Db,
  profile: GitHubProfile,
  options: SignInOptions,
): Promise<SignedIn | null> {
  try {
    return await signInOnce(db, profile, options);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return signInOnce(db, profile, options);
  }
}

async function signInOnce(
  db: Db,
  profile: GitHubProfile,
  options: SignInOptions,
): Promise<SignedIn | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ body: unknown }>(
      "SELECT body FROM accounts WHERE github_user_id = $1 FOR UPDATE",
      [profile.githubUserId],
    );
    const existing = rows[0];
    if (existing !== undefined) {
      const account = parsedBody(Account, existing.body, "account");
      const refreshed: Account = {
        ...account,
        login: profile.login,
        displayName: profile.displayName,
      };
      await tx.query("UPDATE accounts SET body = $2::jsonb WHERE id = $1", [
        account.id,
        asJson(parsedBody(Account, refreshed, "account")),
      ]);
      return { account: refreshed, handle: (await activeHandle(tx, account.id)) ?? "", created: false };
    }
    if (!options.allowNew(profile.login.toLowerCase())) return null;
    const account = parsedBody(
      Account,
      {
        id: options.newAccountId,
        githubUserId: profile.githubUserId,
        login: profile.login,
        displayName: profile.displayName,
        githubCreatedAt: profile.githubCreatedAt,
        plan: "free",
        status: "active",
        createdAt: options.now,
      },
      "account",
    );
    const base = profile.login.toLowerCase();
    const near = await tx.query<{ handle: string }>(
      "SELECT handle FROM handles WHERE handle LIKE $1",
      [`${base.slice(0, 30)}%`],
    );
    const taken = new Set(near.map((row) => row.handle));
    const chosen = handleFor(profile.login, (h) => taken.has(h));
    if (!chosen.ok) return null;
    const handle = parsedBody(
      Handle,
      { handle: chosen.value, accountId: account.id, state: "active", redirectTo: null, createdAt: options.now },
      "handle",
    );
    await tx.query("INSERT INTO accounts (id, github_user_id, body) VALUES ($1, $2, $3::jsonb)", [
      account.id,
      account.githubUserId,
      asJson(account),
    ]);
    await tx.query("INSERT INTO handles (handle, account_id, body) VALUES ($1, $2, $3::jsonb)", [
      handle.handle,
      account.id,
      asJson(handle),
    ]);
    return { account, handle: handle.handle, created: true };
  });
}

export async function accountById(db: Queryable, id: string): Promise<Account | null> {
  const rows = await db.query<{ body: unknown }>("SELECT body FROM accounts WHERE id = $1", [id]);
  return rows[0] === undefined ? null : parsedBody(Account, rows[0].body, "account");
}

/** The account's current handle, if it has one. */
export async function activeHandle(db: Queryable, accountId: string): Promise<string | null> {
  const rows = await db.query<{ handle: string }>(
    "SELECT handle FROM handles WHERE account_id = $1 AND body->>'state' = 'active'",
    [accountId],
  );
  return rows[0]?.handle ?? null;
}

const MAX_CHAIN = 16;

/** What /<name> resolves to (Contract §9), following redirects through the database. */
export async function resolveHandle(db: Queryable, name: string): Promise<HandleLookup> {
  const chain = new Map<string, HandleRecord>();
  let next: string | null = name;
  while (next !== null && chain.size < MAX_CHAIN && !chain.has(next)) {
    const rows = await db.query<{ body: unknown }>("SELECT body FROM handles WHERE handle = $1", [
      next,
    ]);
    if (rows[0] === undefined) break;
    const record = parsedBody(Handle, rows[0].body, "handle");
    chain.set(record.handle, record);
    next = record.state === "redirect" ? record.redirectTo : null;
  }
  return lookupHandle(chain, name);
}
```

`packages/server/src/store/sessions.ts`:

```ts
import { Account } from "@repowiki/hosted";
import { randomToken, sha256Hex } from "../crypto.ts";
import type { Db } from "../db/db.ts";
import { parsedBody } from "./rows.ts";

export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;
/** A session is extended only once its remaining life drops below this, to avoid a write per request. */
const SLIDE_BELOW_MS = (SESSION_DAYS - 1) * DAY_MS;

const plusDays = (now: string, days: number) =>
  new Date(Date.parse(now) + days * DAY_MS).toISOString();

export async function createSession(
  db: Db,
  accountId: string,
  now: string,
): Promise<{ token: string; csrf: string; expiresAt: string }> {
  const token = randomToken();
  const csrf = randomToken();
  const expiresAt = plusDays(now, SESSION_DAYS);
  await db.query(
    "INSERT INTO sessions (id_hash, account_id, csrf, expires_at) VALUES ($1, $2, $3, $4)",
    [sha256Hex(token), accountId, csrf, expiresAt],
  );
  return { token, csrf, expiresAt };
}

/** The signed-in account for a session cookie; an expired session is deleted. */
export async function readSession(
  db: Db,
  token: string,
  now: string,
): Promise<{ account: Account; csrf: string } | null> {
  const rows = await db.query<{ csrf: string; expires_at: Date; body: unknown }>(
    "SELECT s.csrf, s.expires_at, a.body FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id_hash = $1",
    [sha256Hex(token)],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const left = row.expires_at.getTime() - Date.parse(now);
  if (left <= 0) {
    await endSession(db, token);
    return null;
  }
  if (left < SLIDE_BELOW_MS) {
    await db.query("UPDATE sessions SET expires_at = $2 WHERE id_hash = $1", [
      sha256Hex(token),
      plusDays(now, SESSION_DAYS),
    ]);
  }
  return { account: parsedBody(Account, row.body, "account"), csrf: row.csrf };
}

export async function endSession(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE id_hash = $1", [sha256Hex(token)]);
}
```

Add to `packages/server/src/index.ts`:

```ts
export { randomToken, safeEqual, sha256Hex } from "./crypto.ts";
export {
  type CookieOptions,
  parseCookies,
  serializeCookie,
  sessionCookieName,
} from "./http/cookies.ts";
export {
  accountById,
  activeHandle,
  type GitHubProfile,
  resolveHandle,
  type SignedIn,
  type SignInOptions,
  signIn,
} from "./store/accounts.ts";
export { appendAudit } from "./store/audit.ts";
export { parsedBody, StoreError } from "./store/rows.ts";
export { createSession, endSession, readSession, SESSION_DAYS } from "./store/sessions.ts";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm format && node node_modules/vitest/vitest.mjs run packages/server`
Expected: PASS.

- [ ] **Step 6: Check and commit**

```bash
pnpm check
git add packages/server
git -c user.email=sean.may101@gmail.com commit -m "feat(server): add accounts, handles and hashed sessions"
```
