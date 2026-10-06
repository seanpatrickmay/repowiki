import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
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
      expect((await call("DELETE", "/")).status).toBe(405);
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

  it("names --port when the port is in use", async () => {
    const first = await listenLoopback(async () => {}, 0);
    try {
      await expect(listenLoopback(async () => {}, first.port)).rejects.toThrow(/--port/);
    } finally {
      await new Promise((resolve) => first.server.close(resolve));
    }
  });
});
