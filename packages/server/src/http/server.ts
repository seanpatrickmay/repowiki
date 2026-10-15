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

/** Header names in lower case, so a reply's own header replaces the default it names. */
function lowercased(headers: Reply["headers"]): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

async function respond(
  app: App,
  raw: IncomingMessage,
  res: ServerResponse,
  log: (line: object) => void,
) {
  const started = Date.now();
  const method = (raw.method ?? "GET").toUpperCase();
  // Split by hand: the URL parser would resolve "%2E%2E" and read "//x" as a host (S2).
  const target = raw.url ?? "/";
  const at = target.indexOf("?");
  const path = at === -1 ? target : target.slice(0, at);
  const query = new URLSearchParams(at === -1 ? "" : target.slice(at + 1));
  let reply: Reply;
  let error: string | undefined;
  if (!METHODS.has(method)) {
    reply = text(405, "Method not allowed.");
  } else if (!routablePath(path)) {
    reply = text(404, "Not found.");
  } else {
    try {
      reply = await app({
        method: method as Method,
        path,
        params: {},
        query,
        headers: raw.headers,
        raw,
      });
    } catch (e) {
      if (e instanceof HttpError) {
        const base = text(e.status, e.message);
        reply = { ...base, headers: { ...base.headers, ...e.headers } };
      } else {
        error = e instanceof Error ? e.name : "unknown";
        reply = text(500, "Something went wrong.");
      }
    }
  }
  try {
    res.writeHead(reply.status, { ...SECURITY_HEADERS, ...lowercased(reply.headers) });
    res.end(method === "HEAD" ? undefined : reply.body);
  } catch (e) {
    // A reply Node refuses to send (a header holding CR or LF) must not become an unhandled
    // rejection, which would end the process for every user.
    error = e instanceof Error ? e.name : "unknown";
    reply = text(500, "Something went wrong.");
    if (res.headersSent) {
      res.destroy();
    } else {
      res.writeHead(reply.status, { ...SECURITY_HEADERS, ...reply.headers });
      res.end(method === "HEAD" ? undefined : reply.body);
    }
  }
  log({
    method,
    route: path,
    status: reply.status,
    ms: Date.now() - started,
    ...(error === undefined ? {} : { error }),
  });
}

/** The URL a listener on host:port answers at; an IPv6 host is bracketed, as URLs need. */
export function serverUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Serve `app` on host:port (0 for any free port); a bind error (EADDRINUSE) rejects. */
export async function listen(
  app: App,
  options: { port: number; host: string; log?: (line: object) => void },
): Promise<AppServer> {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  const server = createServer((raw, res) => {
    void respond(app, raw, res, log);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    url: serverUrl(options.host, port),
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
