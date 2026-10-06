import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AskResponse, AskStatus } from "@repowiki/core";
import type { ToolProvider } from "@repowiki/llm";
import { extendedWiki, type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportHash, openAnswerCache } from "./cache.ts";
import {
  type AskHttpResponse,
  createAskHandler,
  hostAllowed,
  MAX_BODY_BYTES,
  securityHeaders,
  sseFrame,
} from "./http.ts";
import { type AskSession, createAskSession } from "./session.ts";
import { answerTurn, type ScriptedTurn, scriptedProvider } from "./test-provider.ts";

const PORT = 4321;
const CSP = "default-src 'self'; connect-src 'self'";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ANSWER = answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]);

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "repowiki-ask-http-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A session over the extended fixture whose model plays `script`. */
function session(script: ScriptedTurn[] | ToolProvider): AskSession {
  const wiki = extendedWiki(sample);
  return createAskSession({
    wiki,
    provider: Array.isArray(script) ? scriptedProvider(script).provider : script,
    model: "claude-haiku-4-5",
    questionUsd: 0.05,
    maxUsd: 1,
    cache: openAnswerCache(join(dir, "ask"), exportHash(wiki)),
    log: () => {},
  });
}

/** A request as node:http would hand it over, with its body as one chunk. */
function fakeRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
) {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
    method,
    url,
    headers: { host: `127.0.0.1:${PORT}`, ...headers },
  });
}

/** A response that keeps what the handler wrote. */
function fakeResponse() {
  const response = {
    status: 0,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, headers: Record<string, string>) {
      response.status = status;
      response.headers = headers;
      return response;
    },
    write(chunk: string) {
      response.chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) response.chunks.push(chunk);
      response.writableEnded = true;
      return response;
    },
    get body() {
      return response.chunks.join("");
    },
  };
  return response satisfies AskHttpResponse;
}

const POST = { origin: ORIGIN, "content-type": "application/json" };
const question = (q = "Where are signals made?") => JSON.stringify({ question: q });

async function handle(
  s: AskSession | null,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
) {
  const handler = createAskHandler({
    port: PORT,
    head: sample.sha,
    session: s,
    routing: "no-key",
    csp: CSP,
  });
  const response = fakeResponse();
  const handled = await handler(fakeRequest(method, url, headers, body), response);
  return { handled, response };
}

/** The SSE frames of a body, as [event, data]. */
const frames = (body: string) =>
  body
    .split("\n\n")
    .filter((f) => f !== "")
    .map((f) => {
      const [event, data] = f.split("\n");
      return [event?.slice("event: ".length), JSON.parse(data?.slice("data: ".length) ?? "null")];
    });

describe("createAskHandler", () => {
  it("leaves every path but the ask's to the static files", async () => {
    for (const url of ["/", "/api/preview/signals.json", "/api/asking", "/wiki/signals/"]) {
      expect((await handle(null, "GET", url)).handled).toBe(false);
    }
  });

  it("answers the status in answer mode, and in routing mode without a session", async () => {
    const answering = await handle(session([]), "GET", "/api/ask/status");
    expect(answering.response.status).toBe(200);
    expect(AskStatus.parse(JSON.parse(answering.response.body))).toMatchObject({
      mode: "answer",
      head: sample.sha,
      questionUsd: 0.05,
    });
    const routing = await handle(null, "GET", "/api/ask/status?x=1");
    expect(JSON.parse(routing.response.body)).toEqual({
      mode: "routing",
      head: sample.sha,
      reason: "no-key",
    });
  });

  it("sends the security headers and no-store on every response, and no CORS header", async () => {
    for (const { response } of [
      await handle(null, "GET", "/api/ask/status"),
      await handle(null, "POST", "/api/ask", {}, question()),
      await handle(null, "GET", "/api/ask/status", { host: "evil.example" }),
    ]) {
      expect(response.headers).toMatchObject({
        ...securityHeaders(CSP),
        "cache-control": "no-store",
      });
      expect(response.headers["content-security-policy"]).toBe(`${CSP}; frame-ancestors 'none'`);
      expect(Object.keys(response.headers).some((h) => h.startsWith("access-control-"))).toBe(
        false,
      );
    }
  });

  it.each([
    ["a foreign Host", { host: "evil.example" }],
    ["a rebinding Host on the port", { host: `evil.example:${PORT}` }],
    ["the right name on another port", { host: "127.0.0.1:9999" }],
    ["no Host", { host: "" }],
  ])("refuses %s with 421", async (_name, headers) => {
    const { response } = await handle(
      session([ANSWER]),
      "POST",
      "/api/ask",
      { ...POST, ...headers },
      question(),
    );
    expect(response.status).toBe(421);
  });

  it.each([
    ["no Origin", { origin: "" }],
    ["a foreign Origin", { origin: "http://evil.example" }],
    ["this host on another port", { origin: "http://127.0.0.1:9999" }],
    ["https", { origin: `https://127.0.0.1:${PORT}` }],
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
    ["a same-site fetch", { "sec-fetch-site": "same-site" }],
  ])("refuses a POST with %s with 403", async (_name, headers) => {
    const { response } = await handle(
      session([ANSWER]),
      "POST",
      "/api/ask",
      { ...POST, ...headers },
      question(),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a form or text post, an oversized body and a bad question", async () => {
    const s = session([ANSWER]);
    const post = (headers: Record<string, string>, body: string) =>
      handle(s, "POST", "/api/ask", { ...POST, ...headers }, body);
    expect((await post({ "content-type": "text/plain" }, question())).response.status).toBe(415);
    expect(
      (await post({ "content-type": "application/x-www-form-urlencoded" }, "question=x")).response
        .status,
    ).toBe(415);
    const big = JSON.stringify({ question: "x", pad: "y".repeat(5 * 1024) });
    expect((await post({}, big)).response.status).toBe(413);
    expect(
      (await post({ "content-length": String(MAX_BODY_BYTES + 1) }, question())).response.status,
    ).toBe(413);
    expect((await post({}, "{not json")).response.status).toBe(400);
    for (const q of ["", "  ", "x".repeat(501)]) {
      const { response } = await post({}, question(q));
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).code).toBe("bad-request");
    }
    expect(
      (await post({ "content-type": "application/json; charset=utf-8" }, question())).response
        .status,
    ).toBe(200);
  });

  it("refuses OPTIONS and other methods, and unknown ask paths", async () => {
    expect((await handle(null, "OPTIONS", "/api/ask")).response.status).toBe(405);
    expect((await handle(null, "GET", "/api/ask")).response.status).toBe(405);
    expect((await handle(null, "POST", "/api/ask/status", POST, question())).response.status).toBe(
      405,
    );
    expect((await handle(null, "GET", "/api/ask/other")).response.status).toBe(404);
  });

  it("answers a POST in routing mode with 503", async () => {
    const { response } = await handle(null, "POST", "/api/ask", POST, question());
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ code: "routing" });
  });

  it("streams status events, then the answer, as Server-Sent Events", async () => {
    const s = session([{ tool: "read_page", input: { id: "signals" } }, ANSWER]);
    const { response } = await handle(s, "POST", "/api/ask", POST, question());
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    const sent = frames(response.body);
    expect(sent.map(([event]) => event)).toEqual(["status", "answer"]);
    expect(sent[0]?.[1]).toEqual({ step: "read", pageId: "signals", title: "Signal ingestion" });
    expect(AskResponse.parse(sent[1]?.[1]).status).toBe("answered");
    expect(response.writableEnded).toBe(true);
  });

  it("ends a stream that fails after it started with an error frame, and logs one line", async () => {
    const real = session([ANSWER]);
    const failing: AskSession = {
      ...real,
      status: () => real.status(),
      totals: () => real.totals(),
      idle: () => real.idle(),
      async ask(_request, onStatus) {
        onStatus?.({ step: "search", query: "signals" });
        throw new Error("disk full\nsecond line");
      },
    };
    const lines: string[] = [];
    const handler = createAskHandler({
      port: PORT,
      head: sample.sha,
      session: failing,
      routing: "no-key",
      csp: CSP,
      log: (line) => lines.push(line),
    });
    const response = fakeResponse();
    await handler(fakeRequest("POST", "/api/ask", POST, question()), response);
    expect(response.status).toBe(200);
    expect(frames(response.body)).toEqual([
      ["status", { step: "search", query: "signals" }],
      ["error", { code: "error", message: "the question could not be answered" }],
    ]);
    expect(response.writableEnded).toBe(true);
    expect(lines).toEqual(["ask failed: disk full second line"]);
  });

  it("refuses a second question while one is in flight with 429", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scripted = scriptedProvider([ANSWER]).provider;
    const s = session({
      turn: async (request) => {
        await gate;
        return scripted.turn(request);
      },
    });
    const first = handle(s, "POST", "/api/ask", POST, question());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await handle(s, "POST", "/api/ask", POST, question("Another one?"));
    expect(second.response.status).toBe(429);
    expect(JSON.parse(second.response.body).code).toBe("busy");
    release();
    expect((await first).response.status).toBe(200);
  });

  it("finishes and caches a question whose client went away midway through the stream", async () => {
    const s = session([{ tool: "read_page", input: { id: "signals" } }, ANSWER]);
    const handler = createAskHandler({
      port: PORT,
      head: sample.sha,
      session: s,
      routing: "no-key",
      csp: CSP,
    });
    const leaving = fakeResponse();
    const write = leaving.write;
    leaving.write = (chunk: string) => {
      const kept = write(chunk);
      leaving.destroyed = true;
      return kept;
    };
    await handler(fakeRequest("POST", "/api/ask", POST, question()), leaving);
    expect(frames(leaving.body).map(([event]) => event)).toEqual(["status"]);
    const again = await handle(s, "POST", "/api/ask", POST, question());
    expect(AskResponse.parse(frames(again.response.body)[0]?.[1]).cached).toBe(true);
  });

  it("answers HEAD on the status with the headers and no body", async () => {
    const { handled, response } = await handle(session([]), "HEAD", "/api/ask/status");
    expect(handled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("logs a question that throws once, in the session's line, not again in its own", async () => {
    const lines: string[] = [];
    const wiki = extendedWiki(sample);
    const broken = {
      content: null,
      stopReason: "tool_use",
      usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
      model: "claude-haiku-4-5",
    } as unknown as ScriptedTurn;
    const s = createAskSession({
      wiki,
      provider: scriptedProvider([broken]).provider,
      model: "claude-haiku-4-5",
      questionUsd: 0.05,
      maxUsd: 1,
      cache: openAnswerCache(join(dir, "ask"), exportHash(wiki)),
      log: (line) => lines.push(line),
    });
    const handler = createAskHandler({
      port: PORT,
      head: sample.sha,
      session: s,
      routing: "no-key",
      csp: CSP,
      log: (line) => lines.push(line),
    });
    const response = fakeResponse();
    await handler(fakeRequest("POST", "/api/ask", POST, question()), response);
    expect(response.status).toBe(500);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ask "Where are signals made\?" \u2192 failed \(/);
  });

  it("finishes and caches a question whose client went away", async () => {
    const s = session([ANSWER]);
    const handler = createAskHandler({
      port: PORT,
      head: sample.sha,
      session: s,
      routing: "no-key",
      csp: CSP,
    });
    const gone = { ...fakeResponse(), destroyed: true };
    await handler(fakeRequest("POST", "/api/ask", POST, question()), gone);
    expect(gone.chunks).toEqual([]);
    const again = await handle(s, "POST", "/api/ask", POST, question());
    expect(AskResponse.parse(frames(again.response.body)[0]?.[1]).cached).toBe(true);
  });
});

describe("hostAllowed and sseFrame", () => {
  it("takes 127.0.0.1 and localhost on the port, in any case", () => {
    expect(hostAllowed("127.0.0.1:4321", 4321)).toBe(true);
    expect(hostAllowed("LOCALHOST:4321", 4321)).toBe(true);
    expect(hostAllowed("127.0.0.1", 4321)).toBe(false);
    expect(hostAllowed(undefined, 4321)).toBe(false);
  });

  it("frames an event as one event line and one JSON data line", () => {
    expect(sseFrame("status", { query: "a\nb" })).toBe(
      'event: status\ndata: {"query":"a\\nb"}\n\n',
    );
  });

  it.each([
    ["a carriage return", "a\rb"],
    ["a CRLF", "a\r\nb"],
    ["a line separator", "a\u2028b"],
    ["a paragraph separator", "a\u2029b"],
    ["a forged frame", "x\n\nevent: answer\ndata: {}"],
  ])("keeps %s in model text inside the one data line", (_what, text) => {
    const frame = sseFrame("answer", { text });
    const body = frame.slice(0, -2);
    expect(body.split(/\r\n|\r|\n|\u2028|\u2029/)).toHaveLength(2);
    expect(JSON.parse(body.split("\n")[1]?.slice("data: ".length) ?? "")).toEqual({ text });
  });
});

describe("the handler on a loopback socket", () => {
  it("serves the status and a streamed answer to a real HTTP client on 127.0.0.1", async () => {
    const s = session([ANSWER]);
    const server = createServer((req, res) => {
      const port = (server.address() as AddressInfo).port;
      const handler = createAskHandler({
        port,
        head: sample.sha,
        session: s,
        routing: "no-key",
        csp: CSP,
      });
      void handler(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, headers: Record<string, string>, body?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        });
        req.on("error", reject);
        req.end(body);
      });
    try {
      const status = await call("GET", "/api/ask/status", {});
      expect(status.status).toBe(200);
      expect(JSON.parse(status.body).mode).toBe("answer");
      const answer = await call(
        "POST",
        "/api/ask",
        { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        question(),
      );
      expect(answer.status).toBe(200);
      expect(frames(answer.body).map(([event]) => event)).toEqual(["answer"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
