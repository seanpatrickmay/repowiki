import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAskHandler, createAskSession, exportHash, openAnswerCache } from "@repowiki/ask";
import { answerTurn, scriptedProvider } from "@repowiki/ask/test-provider";
import { type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contentTypeFor,
  listenLoopback,
  resolveStaticPath,
  serveBuilding,
  serveRequests,
} from "./serve-static.ts";

let sample: SampleWiki;
let root: string;
let site: string;
beforeAll(() => {
  sample = sampleWiki();
  root = realpathSync(mkdtempSync(join(tmpdir(), "repowiki-serve-cli-")));
  site = join(root, "site");
  mkdirSync(join(site, "wiki", "signals"), { recursive: true });
  writeFileSync(join(site, "index.html"), "<p>main</p>");
  writeFileSync(join(site, "404.html"), "<p>missing</p>");
  writeFileSync(join(site, "wiki", "signals", "index.html"), "<p>signals</p>");
  mkdirSync(join(site, "api", "previews"), { recursive: true });
  writeFileSync(join(site, "api", "previews", "signals.json"), '{"title":"Signals"}');
  writeFileSync(join(site, ".repowiki-site"), "");
  writeFileSync(join(root, "secret.txt"), "outside");
  symlinkSync(join(root, "secret.txt"), join(site, "link.txt"));
  symlinkSync(root, join(site, "up"));
});
afterAll(() => {
  sample.repo.remove();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveStaticPath", () => {
  it("serves a file, and a directory's index.html", () => {
    expect(resolveStaticPath(site, "/")).toBe(join(site, "index.html"));
    expect(resolveStaticPath(site, "/wiki/signals/")).toBe(
      join(site, "wiki", "signals", "index.html"),
    );
    expect(resolveStaticPath(site, "/wiki/signals?x=1#y")).toBe(
      join(site, "wiki", "signals", "index.html"),
    );
    expect(resolveStaticPath(site, "/404.html")).toBe(join(site, "404.html"));
  });

  it.each([
    "/../secret.txt",
    "/wiki/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/wiki%2f..%2f..%2fsecret.txt",
    "/wiki/%2E/signals/",
    "/wiki//signals/",
    "/index.html%00.txt",
    "/wiki\\..\\..\\secret.txt",
    "/.repowiki-site",
    "/wiki/.hidden",
    "/link.txt",
    "/up/secret.txt",
    "/nope.html",
    "/%E0%A4%A",
    "relative/index.html",
    "/index.html/",
    "/wiki/signals/index.html/",
  ])("refuses %s", (url) => {
    expect(resolveStaticPath(site, url)).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("types files by extension, anything else as octet-stream", () => {
    expect(contentTypeFor("a/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("pagefind/pagefind.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("pagefind/wasm.en.pagefind")).toBe("application/octet-stream");
    expect(contentTypeFor("x.WASM")).toBe("application/wasm");
  });
});

describe("serveRequests on a loopback socket", () => {
  it("serves files and the ask from one origin, guarding the Host of every request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-serve-ask-"));
    let port = 0;
    const session = createAskSession({
      wiki: sample.wiki,
      provider: scriptedProvider([
        answerTurn([["Signals are made by `ingest_chunk`.", ["signals#s-1"]]]),
      ]).provider,
      model: "claude-haiku-4-5",
      questionUsd: 0.05,
      maxUsd: 1,
      cache: openAnswerCache(join(dir, "ask"), exportHash(sample.wiki)),
      log: () => {},
    });
    const csp = "default-src 'self'";
    const ask = createAskHandler({
      get port() {
        return port;
      },
      head: sample.sha,
      session,
      routing: "no-key",
      csp,
    });
    const listening = await listenLoopback(
      serveRequests({ siteDir: site, csp, port: () => port, ask }),
      0,
    );
    port = listening.port;
    expect((listening.server.address() as AddressInfo).address).toBe("127.0.0.1");
    const call = (
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body?: string,
    ) =>
      new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
        (resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
            );
          });
          req.on("error", reject);
          req.end(body);
        },
      );
    try {
      const page = await call("GET", "/wiki/signals/");
      expect(page).toMatchObject({ status: 200, body: "<p>signals</p>" });
      expect(page.headers).toMatchObject({
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `${csp}; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
      });
      expect(await call("GET", "/missing/")).toMatchObject({ status: 404, body: "<p>missing</p>" });
      expect((await call("GET", "/../secret.txt")).status).toBe(404);
      const refused = await call("DELETE", "/");
      expect(refused.status).toBe(405);
      expect(refused.headers).toMatchObject({
        allow: "GET, HEAD",
        "content-security-policy": `${csp}; frame-ancestors 'none'`,
      });
      const preview = await call("GET", "/api/previews/signals.json");
      expect(preview).toMatchObject({ status: 200, body: '{"title":"Signals"}' });
      expect(preview.headers["cache-control"]).toBe("no-store");
      expect((await call("GET", "/", { host: `evil.example:${port}` })).status).toBe(421);
      expect((await call("HEAD", "/")).body).toBe("");
      const status = await call("GET", "/api/ask/status");
      expect(status.headers["cache-control"]).toBe("no-store");
      expect(JSON.parse(status.body).mode).toBe("answer");
      const answer = await call(
        "POST",
        "/api/ask",
        { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        JSON.stringify({ question: "Where are signals made?" }),
      );
      expect(answer.status).toBe(200);
      expect(answer.body).toContain("event: answer");
    } finally {
      await new Promise((resolve) => listening.server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers a handler that throws with 500, the security headers and one log line", async () => {
    const csp = "default-src 'self'";
    const lines: string[] = [];
    let port = 0;
    const listening = await listenLoopback(
      serveRequests({
        siteDir: site,
        csp,
        port: () => port,
        ask: async () => {
          throw new Error("read failed\nhere");
        },
        log: (line) => lines.push(line),
      }),
      0,
    );
    port = listening.port;
    try {
      const response = await new Promise<{ status: number; headers: Record<string, unknown> }>(
        (resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port, path: "/boom" }, (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
          });
          req.on("error", reject);
          req.end();
        },
      );
      expect(response.status).toBe(500);
      expect(response.headers).toMatchObject({
        "content-security-policy": `${csp}; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
      });
      expect(lines).toEqual(["serve: GET /boom failed (read failed here)"]);
    } finally {
      await new Promise((resolve) => listening.server.close(resolve));
    }
  });

  it("answers 503 while the site builds, but 421 first for a foreign Host", async () => {
    const csp = "default-src 'self'";
    let port = 0;
    const listening = await listenLoopback(serveBuilding({ csp, port: () => port }), 0);
    port = listening.port;
    const get = (headers: Record<string, string>) =>
      new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
        (resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port, path: "/", headers }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
            );
          });
          req.on("error", reject);
          req.end();
        },
      );
    try {
      const foreign = await get({ host: `evil.example:${port}` });
      expect(foreign.status).toBe(421);
      expect(foreign.headers["content-security-policy"]).toBe(`${csp}; frame-ancestors 'none'`);
      const building = await get({});
      expect(building.status).toBe(503);
      expect(building.headers).toMatchObject({
        "cache-control": "no-store",
        "retry-after": "5",
        "content-security-policy": `${csp}; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
      });
      expect(building.body).toBe("The site is being built; try again in a moment.\n");
    } finally {
      await new Promise((resolve) => listening.server.close(resolve));
    }
  });

  it("answers HEAD with a file's length and no body, as GET would send it", async () => {
    let port = 0;
    const listening = await listenLoopback(
      serveRequests({
        siteDir: site,
        csp: "default-src 'self'",
        port: () => port,
        ask: async () => false,
      }),
      0,
    );
    port = listening.port;
    const call = (method: string) =>
      new Promise<{ status: number; length: unknown; body: string }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, method, path: "/wiki/signals/" },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                length: res.headers["content-length"],
                body: text,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      expect(await call("GET")).toEqual({ status: 200, length: "14", body: "<p>signals</p>" });
      expect(await call("HEAD")).toEqual({ status: 200, length: "14", body: "" });
    } finally {
      await new Promise((resolve) => listening.server.close(resolve));
    }
  });

  it("answers a handler that throws past serveRequests with a 500 that still has safe headers", async () => {
    const listening = await listenLoopback(async () => {
      throw new Error("boom");
    }, 0);
    try {
      const response = await new Promise<{ status: number; headers: Record<string, unknown> }>(
        (resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port: listening.port, path: "/" }, (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
          });
          req.on("error", reject);
          req.end();
        },
      );
      expect(response.status).toBe(500);
      expect(response.headers).toMatchObject({
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
    } finally {
      await new Promise((resolve) => listening.server.close(resolve));
    }
  });

  it("logs a server error after it is listening, on one line", async () => {
    const lines: string[] = [];
    const listening = await listenLoopback(
      async () => {},
      0,
      (line) => lines.push(line),
    );
    try {
      listening.server.emit("error", new Error("too many open files\nnow"));
      expect(lines).toEqual(["serve: the server failed (too many open files now)"]);
    } finally {
      await new Promise((resolve) => listening.server.close(resolve));
    }
  });

  it("names --port when the port is in use", async () => {
    const first = await listenLoopback(async () => {}, 0);
    try {
      await expect(listenLoopback(async () => {}, first.port)).rejects.toThrow(/--port/);
    } finally {
      await new Promise((resolve) => first.server.close(resolve));
    }
  });
});
