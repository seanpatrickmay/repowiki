import { createReadStream, realpathSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
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
 * directory serves its index.html; a file named with a trailing slash is a 404.
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
  const directory = segments.at(-1) === "";
  if (directory) segments.pop();
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) return null;
  try {
    const root = realpathSync(siteDir);
    let target = realpathSync(join(root, ...segments));
    if (!inside(root, target)) return null;
    if (statSync(target).isDirectory()) {
      target = realpathSync(join(target, "index.html"));
      if (!inside(root, target)) return null;
    } else if (directory && segments.length > 0) {
      // A file named as a directory ("/index.html/") is no page of the site.
      return null;
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
    // A file is streamed, not read whole, so a large one neither blocks an answer's stream nor
    // sits in memory; HEAD sends its length and no body.
    const sendFile = async (status: number, type: string, path: string) => {
      const { size } = await stat(path);
      response.writeHead(status, {
        ...headers,
        ...api,
        "content-type": type,
        "content-length": String(size),
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      await pipeline(createReadStream(path), response);
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
        await sendFile(200, contentTypeFor(file), file);
        return;
      }
      const missing = resolveStaticPath(options.siteDir, "/404.html");
      if (missing === null) send(404, "text/plain; charset=utf-8", "Not found.\n");
      else await sendFile(404, "text/html; charset=utf-8", missing);
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
 * wiki:serve's answer while the site is still being built: the Host guard first (421, R18, as
 * serveRequests), then 503 with the security headers, no-store and Retry-After.
 */
export function serveBuilding(options: {
  csp: string;
  port: () => number;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const headers = securityHeaders(options.csp);
  return async (request, response) => {
    const allowed = hostAllowed(request.headers.host, options.port());
    response.writeHead(allowed ? 503 : 421, {
      ...headers,
      "cache-control": "no-store",
      ...(allowed ? { "retry-after": "5" } : {}),
      "content-type": "text/plain; charset=utf-8",
    });
    response.end(
      request.method === "HEAD"
        ? undefined
        : allowed
          ? "The site is being built; try again in a moment.\n"
          : "This server answers only as 127.0.0.1 or localhost.\n",
    );
  };
}

/** The headers of the last-resort 500: text, no store, and a CSP that allows nothing. */
const LAST_RESORT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

/**
 * Listens on 127.0.0.1 only (spec v2 #4 R18: there is no --host); a busy port is a CliError
 * naming --port. Resolves with the server and the port it took (`port` 0 takes any free one).
 * A handler that throws past its own catch gets a bare 500 with LAST_RESORT_HEADERS; a server
 * error once listening is logged on one line.
 */
export function listenLoopback(
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  port: number,
  log: (line: string) => void = () => {},
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, LAST_RESORT_HEADERS);
        response.end();
      });
    });
    const starting = (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new CliError(
              `port ${port} is in use (is pnpm site:preview running?); choose another with --port`,
            )
          : error,
      );
    };
    server.once("error", starting);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", starting);
      server.on("error", (error: Error) => {
        log(`serve: the server failed (${cut(oneLine(error.message), 200)})`);
      });
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}
