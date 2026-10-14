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
