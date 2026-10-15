import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BODY_LIMIT, HttpError, readJson } from "./body.ts";
import { createRouter, type RouteRequest } from "./router.ts";
import { type AppServer, html, json, listen } from "./server.ts";

const logs: object[] = [];
let server: AppServer;

beforeAll(async () => {
  const route = createRouter([
    {
      method: "GET",
      pattern: "/hello/:name",
      handler: async (r) => html(200, `hi ${r.params.name}`),
    },
    {
      method: "POST",
      pattern: "/json",
      handler: async (r) => json(200, await readJson(r.raw, z.strictObject({ n: z.int() }))),
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
      pattern: "/bad-header",
      handler: async () => ({ status: 302, headers: { location: "/x\r\nset-cookie: a=b" } }),
    },
    {
      method: "GET",
      pattern: "/own-csp",
      handler: async () => ({
        status: 200,
        headers: { "Content-Security-Policy": "default-src 'none'" },
        body: "x",
      }),
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
    // Each of these has /hello/:name's shape, so only the dot-segment check can refuse it.
    for (const path of ["/hello/%2E%2E", "/hello/.", "/hello/..", "/hello/%2e"]) {
      const raw = await rawRequest(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
      expect(raw, path).toMatch(/^HTTP\/1\.1 404/);
    }
    expect(await rawRequest("GET //hello/sean HTTP/1.1\r\nHost: x\r\n\r\n")).toMatch(
      /^HTTP\/1\.1 404/,
    );
  });

  it("hides an unexpected error behind a generic 500 and logs only its name", async () => {
    const response = await fetch(`${server.url}/boom`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("passwd");
    expect(JSON.stringify(logs)).not.toContain("passwd");
    expect(logs.at(-1)).toMatchObject({
      method: "GET",
      route: "/boom",
      status: 500,
      error: "Error",
    });
  });

  it("answers 500 for a reply it cannot send, and keeps serving", async () => {
    const response = await fetch(`${server.url}/bad-header`, { redirect: "manual" });
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(logs.at(-1)).toMatchObject({ route: "/bad-header", status: 500 });
    expect((await fetch(`${server.url}/hello/sean`)).status).toBe(200);
  });

  it("sends one CSP, the reply's own, whatever the case of its header name", async () => {
    const raw = await rawRequest("GET /own-csp HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    const csp = raw.split("\r\n").filter((line) => /^content-security-policy:/i.test(line));
    expect(csp).toEqual([expect.stringMatching(/: default-src 'none'$/)]);
  });

  it("answers an HttpError with its status and message", async () => {
    const response = await fetch(`${server.url}/teapot`);
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("short and stout");
  });
});

describe("bodies over HTTP (spec 2 S2)", () => {
  const post = (path: string, body: string, type: string) =>
    fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": type }, body });

  it("refuses a body over the limit, declared or streamed", async () => {
    const big = `{"n":1,"pad":"${"x".repeat(BODY_LIMIT)}"}`;
    expect((await post("/json", big, "application/json")).status).toBe(413);
    const chunked = await rawRequest(
      `POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${(BODY_LIMIT + 10).toString(16)}\r\n${"x".repeat(BODY_LIMIT + 10)}\r\n0\r\n\r\n`,
    );
    expect(chunked).toMatch(/^HTTP\/1\.1 413/);
  });

  it("answers 413 while an oversized body is still arriving", async () => {
    const { connect } = await import("node:net");
    const { port } = new URL(server.url);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        const chunk = "x".repeat(BODY_LIMIT + 10);
        socket.write(
          `POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n`,
        );
      });
      socket.once("data", (data) => {
        resolve(data.toString());
        socket.destroy();
      });
      socket.on("close", () => resolve(""));
      socket.on("error", reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 413/);
  });
});

describe("a declared oversized body (spec 2 S2)", () => {
  it("is refused at once and the connection closed rather than drained", async () => {
    const { connect } = await import("node:net");
    const { port } = new URL(server.url);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `POST /json HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${BODY_LIMIT * 100}\r\n\r\n{"n":`,
        );
      });
      socket.once("data", (data) => {
        resolve(data.toString());
        socket.destroy();
      });
      socket.on("error", reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 413/);
    expect(reply).toMatch(/\r\nconnection: close\r\n/i);
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
