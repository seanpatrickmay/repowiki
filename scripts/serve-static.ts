import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, sep } from "node:path";
import { hostAllowed, securityHeaders } from "@repowiki/ask";
import { cut, oneLine } from "@repowiki/query";
import { CliError } from "./manifest-cli.ts";

/** Content types by extension; anything else is application/octet-stream (spec v2 #4 §7). */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

export const contentTypeFor = (path: string): string =>
  CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
};

/**
 * The file a URL path names under the site (spec v2 #4 §7), or null for a 404: the path is
 * percent-decoded once and may hold no NUL, backslash, `.`, `..` or empty segment, and no
 * dotfile; the file's real path must stay inside the site's (a symlink out is a 404). A
 * directory serves its index.html.
 */
export function resolveStaticPath(siteDir: string, url: string): string | null {
  const raw = url.split("?")[0]?.split("#")[0] ?? "";
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!path.startsWith("/") || /[\0\\]/.test(path)) return null;
  const segments = path.slice(1).split("/");
  if (segments.at(-1) === "") segments.pop();
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) return null;
  try {
    const root = realpathSync(siteDir);
    let target = realpathSync(join(root, ...segments));
    if (!inside(root, target)) return null;
    if (statSync(target).isDirectory()) {
      target = realpathSync(join(target, "index.html"));
      if (!inside(root, target)) return null;
    }
    return statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

/** A request handler that says whether it answered (the ask's), as createAskHandler does. */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

/**
 * wiki:serve's request handling: every request must name this server as its Host (421, R18);
 * the ask's endpoints, then the site's files, GET and HEAD only (405, with Allow), each with the
 * security headers (§9.2) and /api/ responses with no-store; a miss serves 404.html with 404. A
 * request that throws is a 500 with the same headers (when none were sent yet), logged on one
 * line.
 */
export function serveRequests(options: {
  siteDir: string;
  csp: string;
  port: () => number;
  ask: RouteHandler;
  /** One terminal line for a request that failed. */
  log?: (line: string) => void;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const headers = securityHeaders(options.csp);
  return async (request, response) => {
    const url = request.url ?? "/";
    const api = url.startsWith("/api/") ? { "cache-control": "no-store" } : {};
    const send = (
      status: number,
      type: string,
      body: Buffer | string,
      extra: Record<string, string> = {},
    ) => {
      response.writeHead(status, {
        ...headers,
        ...api,
        ...extra,
        "content-type": type,
        "content-length": String(Buffer.byteLength(body)),
      });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    try {
      if (!hostAllowed(request.headers.host, options.port())) {
        send(
          421,
          "text/plain; charset=utf-8",
          "This server answers only as 127.0.0.1 or localhost.\n",
        );
        return;
      }
      if (await options.ask(request, response)) return;
      if (request.method !== "GET" && request.method !== "HEAD") {
        send(405, "text/plain; charset=utf-8", "Only GET and HEAD.\n", { allow: "GET, HEAD" });
        return;
      }
      const file = resolveStaticPath(options.siteDir, url);
      if (file !== null) {
        send(200, contentTypeFor(file), readFileSync(file));
        return;
      }
      const missing = resolveStaticPath(options.siteDir, "/404.html");
      if (missing === null) send(404, "text/plain; charset=utf-8", "Not found.\n");
      else send(404, "text/html; charset=utf-8", readFileSync(missing));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      options.log?.(
        `serve: ${cut(oneLine(request.method ?? "GET"), 10)} ${cut(oneLine(url), 120)} failed (${cut(oneLine(why), 200)})`,
      );
      if (!response.headersSent) send(500, "text/plain; charset=utf-8", "Server error.\n");
      else response.end();
    }
  };
}

/**
 * Listens on 127.0.0.1 only (spec v2 #4 R18: there is no --host); a busy port is a CliError
 * naming --port. Resolves with the server and the port it took (`port` 0 takes any free one).
 */
export function listenLoopback(
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  port: number,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new CliError(
              `port ${port} is in use (is pnpm site:preview running?); choose another with --port`,
            )
          : error,
      );
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}
