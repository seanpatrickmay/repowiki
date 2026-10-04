import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One recorded HTTP exchange. Only the method, path, and JSON body of the request are kept, and
 * only the status, content type, and body of the response: no headers, so no API key, ever.
 */
export interface CassetteEntry {
  request: { method: string; path: string; body: unknown };
  response: { status: number; contentType: string | null; body: string };
}

export type CassetteMode = "replay" | "record";

/** "record" only when REPOWIKI_CASSETTE=record; every other run, CI included, replays. */
export function cassetteMode(): CassetteMode {
  return process.env.REPOWIKI_CASSETTE === "record" ? "record" : "replay";
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class CassetteMissError extends Error {
  constructor(file: string, method: string, path: string) {
    super(
      `${file} has no unused recording for ${method} ${path}; re-record with pnpm cassettes:record`,
    );
    this.name = new.target.name;
  }
}

/** JSON with object keys sorted, so key order never decides whether a request matches. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function parseBody(body: RequestInit["body"]): unknown {
  if (body === undefined || body === null) return null;
  if (typeof body !== "string") throw new Error("cassettes only support string request bodies");
  return JSON.parse(body);
}

/**
 * A fetch that replays exchanges from `file`, or in record mode forwards to `upstream` and writes
 * every exchange to `file` (replacing its previous contents). Identical requests replay in order.
 */
export function cassetteFetch(
  file: string,
  mode: CassetteMode,
  upstream: FetchLike = fetch,
): FetchLike {
  // Fail closed: only an explicit "record" may reach the network, whatever a cast lets through.
  if (mode !== "replay" && mode !== "record") {
    throw new Error(`cassette mode must be "replay" or "record", got ${JSON.stringify(mode)}`);
  }
  const entries: CassetteEntry[] =
    mode === "replay" && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const used = new Set<number>();
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = `${url.pathname}${url.search}`;
    const body = parseBody(init?.body);
    if (mode !== "record") {
      const key = canonical({ method, path, body });
      const index = entries.findIndex(
        (entry, i) => !used.has(i) && canonical(entry.request) === key,
      );
      const entry = entries[index];
      if (entry === undefined) throw new CassetteMissError(file, method, path);
      used.add(index);
      return toResponse(entry);
    }
    const response = await upstream(input, init);
    const recorded: CassetteEntry = {
      request: { method, path, body },
      response: {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.text(),
      },
    };
    entries.push(recorded);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
    return toResponse(recorded);
  };
}

function toResponse({ response }: CassetteEntry): Response {
  const headers =
    response.contentType === null ? undefined : { "content-type": response.contentType };
  return new Response(response.body, { status: response.status, headers });
}
