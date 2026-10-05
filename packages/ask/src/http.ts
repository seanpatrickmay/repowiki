import { type AskProgress, AskRequest, AskResponse, type AskStatus } from "@repowiki/core";
import { cut, oneLine } from "@repowiki/query";
import { type AskSession, BusyError } from "./session.ts";

/** The largest POST /api/ask body read (spec v2 #4 R18). */
export const MAX_BODY_BYTES = 4096;

/** The ask's two endpoints. Every other /api/ path is a static file (the hover previews). */
export const STATUS_PATH = "/api/ask/status";
export const ASK_PATH = "/api/ask";

/** The slice of node:http's IncomingMessage the handler reads, so a test can stand in for it. */
export interface AskHttpRequest extends AsyncIterable<Uint8Array | string> {
  method?: string;
  url?: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** The slice of node:http's ServerResponse the handler writes. */
export interface AskHttpResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
}

/**
 * The headers of every response wiki:serve sends (spec v2 #4 §9.2): the site's policy with
 * `frame-ancestors 'none'`, which a meta cannot set, and no sniffing, referrer or cross-origin
 * reads. No Access-Control-* header is ever sent.
 */
export function securityHeaders(csp: string): Record<string, string> {
  return {
    "content-security-policy": `${csp}; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
}

const header = (request: AskHttpRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * True when a request names this server as its host: `127.0.0.1:<port>` or `localhost:<port>`
 * (spec v2 #4 R18). Any other Host, a rebinding domain's included, is refused with 421.
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  const name = host?.toLowerCase();
  return name === `127.0.0.1:${port}` || name === `localhost:${port}`;
}

/** True when a POST comes from a page of this server (R18): its Origin, and Sec-Fetch-Site. */
function sameOrigin(request: AskHttpRequest, port: number): boolean {
  const origin = header(request, "origin")?.toLowerCase();
  if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return false;
  const site = header(request, "sec-fetch-site");
  return site === undefined || site === "same-origin";
}

export interface AskHandlerOptions {
  /** The port the server listens on, which Host and Origin must name. */
  port: number;
  head: string;
  /** The session answering questions, or null in routing mode. */
  session: AskSession | null;
  /** Why there is no session (R23): no API key, or --no-ask. */
  routing: "no-key" | "disabled";
  /** The site's Content-Security-Policy, the one Layout.astro's meta renders. */
  csp: string;
  /** One terminal line for a question that failed in a way the reader is not told. */
  log?: (line: string) => void;
}

/** An SSE frame: one event line and one data line of JSON (which never holds a raw newline). */
export const sseFrame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * The Ask endpoints of wiki:serve (spec v2 #4 §4.2): `GET /api/ask/status` and `POST /api/ask`,
 * behind R18's guard. A POST answers as Server-Sent Events: `status` frames while the question is
 * answered, then one `answer` frame with the validated AskResponse. A refusal before the answer
 * starts is a JSON error with its status code. A client that disconnects does not cancel a turn
 * in flight. Returns false for a path that is not the ask's, which the caller serves as a file.
 */
export function createAskHandler(
  options: AskHandlerOptions,
): (request: AskHttpRequest, response: AskHttpResponse) => Promise<boolean> {
  const base = { ...securityHeaders(options.csp), "cache-control": "no-store" };
  const json = (response: AskHttpResponse, status: number, body: unknown) => {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { ...base, "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  };
  const refuse = (response: AskHttpResponse, status: number, code: string, message: string) =>
    json(response, status, { code, message });
  const status = (): AskStatus =>
    options.session?.status() ?? { mode: "routing", head: options.head, reason: options.routing };

  return async (request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (path !== ASK_PATH && !path.startsWith(`${ASK_PATH}/`)) return false;
    if (!hostAllowed(header(request, "host"), options.port)) {
      refuse(response, 421, "host", "this server answers only as 127.0.0.1 or localhost");
      return true;
    }
    const method = request.method ?? "GET";
    if (path === STATUS_PATH) {
      if (method !== "GET" && method !== "HEAD") refuse(response, 405, "method", "use GET");
      else json(response, 200, status());
      return true;
    }
    if (path !== ASK_PATH) {
      refuse(response, 404, "not-found", "no such endpoint");
      return true;
    }
    if (method !== "POST") {
      refuse(response, 405, "method", "use POST");
      return true;
    }
    if (!sameOrigin(request, options.port)) {
      refuse(response, 403, "origin", "questions are taken only from this server's own pages");
      return true;
    }
    const type = header(request, "content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      refuse(response, 415, "content-type", "send the question as application/json");
      return true;
    }
    const length = Number(header(request, "content-length") ?? "0");
    if (length > MAX_BODY_BYTES) {
      refuse(response, 413, "too-large", `the body is over ${MAX_BODY_BYTES} bytes`);
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) {
        refuse(response, 413, "too-large", `the body is over ${MAX_BODY_BYTES} bytes`);
        return true;
      }
      chunks.push(bytes);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      refuse(response, 400, "bad-json", "the body is not JSON");
      return true;
    }
    const parsed = AskRequest.safeParse(body);
    if (!parsed.success) {
      const why = parsed.error.issues
        .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`)
        .join("; ");
      refuse(response, 400, "bad-request", cut(oneLine(why), 300));
      return true;
    }
    const session = options.session;
    if (session === null) {
      refuse(response, 503, "routing", `answers are off (${options.routing}); use the page search`);
      return true;
    }
    let started = false;
    const send = (event: string, data: unknown) => {
      if (response.writableEnded || response.destroyed) return;
      if (!started) {
        response.writeHead(200, {
          ...base,
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        });
        started = true;
      }
      response.write(sseFrame(event, data));
    };
    try {
      const answer = await session.ask(parsed.data, (progress: AskProgress) =>
        send("status", progress),
      );
      send("answer", AskResponse.parse(answer));
      if (!response.writableEnded && !response.destroyed) response.end();
    } catch (error) {
      if (started) {
        if (!response.writableEnded && !response.destroyed) response.end();
      } else if (error instanceof BusyError) {
        refuse(response, 429, "busy", "another question is being answered; ask again in a moment");
      } else {
        refuse(response, 500, "error", "the question could not be answered");
        const why = error instanceof Error ? error.message : String(error);
        options.log?.(`ask failed: ${cut(oneLine(why), 200)}`);
      }
    }
    return true;
  };
}
