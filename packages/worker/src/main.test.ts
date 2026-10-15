import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WikiExport } from "@repowiki/core";
import { Facts, Suggestions } from "@repowiki/hosted";
import { afterEach, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const TOKEN = "Abc_-".repeat(8).concat("xyz");
const SPEC = {
  jobId: "00000000-0000-4000-8000-000000000001",
  attempt: 1,
  kind: "generate",
  commitSha: "a".repeat(40),
  repo: {
    fullName: "demo-dev/demo-repo",
    name: "demo-repo",
    cloneUrl: "https://github.com/demo-dev/demo-repo.git",
    sizeKb: 120,
  },
  author: { login: "demo-dev", githubUserId: 4242, commitShas: [] },
  limits: { maxIndexedFiles: 1000 },
  llmUrl: "http://127.0.0.1:1/llm",
};

const read = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** The server's internal API on loopback, recording each call. */
async function fakeServer() {
  const calls: { path: string; auth: string | undefined; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const body = await read(request);
    calls.push({ path: String(request.url), auth: request.headers.authorization, body });
    if (request.url === "/internal/job/lease") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(SPEC));
    } else response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** main.ts with exactly the environment the local runner gives it (and `extra`). */
function runMain(env: Record<string, string>, args: string[] = []) {
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: mkdtempSync(join(tmpdir(), "h-")),
        ...env,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

let close: (() => Promise<unknown>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe("the worker's entry point (spec 2 S9, S18)", () => {
  it("runs fixture mode with only the local runner's environment", async () => {
    const server = await fakeServer();
    close = server.close;
    const { code, stderr } = await runMain({
      REPOWIKI_API_URL: server.url,
      REPOWIKI_JOB_TOKEN: TOKEN,
      REPOWIKI_WORKER_MODE: "fixture",
    });
    expect(code).toBe(0);
    expect(stderr).not.toContain(TOKEN);
    const paths = server.calls.map((c) => c.path.replace("/internal/job/", ""));
    expect(paths[0]).toBe("lease");
    expect(paths.slice(-2)).toEqual(["export", "succeed"]);
    expect(server.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    const exported = server.calls.find((c) => c.path.endsWith("/export"))?.body ?? "";
    expect(WikiExport.safeParse(JSON.parse(exported)).success).toBe(true);
    const succeeded = JSON.parse(server.calls.at(-1)?.body ?? "{}");
    expect(Facts.safeParse(succeeded.facts).success).toBe(true);
    expect(Suggestions.safeParse(succeeded.suggestions).success).toBe(true);
  }, 30_000);

  it("refuses a bad environment naming the fields, never their values", async () => {
    const { code, stderr } = await runMain({
      REPOWIKI_API_URL: "ftp://nowhere",
      REPOWIKI_JOB_TOKEN: "short-secret",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("REPOWIKI_API_URL");
    expect(stderr).toContain("REPOWIKI_JOB_TOKEN");
    expect(stderr).not.toContain("short-secret");
    expect(stderr).not.toContain("ftp://nowhere");
  }, 30_000);

  it("refuses a lone phase without a work directory, and an unknown phase, before leasing", async () => {
    const server = await fakeServer();
    close = server.close;
    const env = { REPOWIKI_API_URL: server.url, REPOWIKI_JOB_TOKEN: TOKEN };
    expect((await runMain(env, ["phase2"])).code).toBe(1);
    expect((await runMain(env, ["phase3"])).code).toBe(1);
    expect(server.calls).toEqual([]);
  }, 30_000);
});
