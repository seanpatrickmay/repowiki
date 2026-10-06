import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = "scripts/wiki-serve.ts";
/** Spawning node and loading the packages takes a few seconds on a loaded machine. */
const PROCESS_TIMEOUT_MS = 30_000;

let sample: SampleWiki;
let out: string;
beforeAll(() => {
  sample = sampleWiki();
  out = mkdtempSync(join(tmpdir(), "repowiki-serve-out-"));
  writeFileSync(join(out, "export.json"), `${JSON.stringify(sample.wiki, null, 2)}\n`);
  // A site already built from this export, so serving it needs no Astro build.
  const site = join(out, "site");
  mkdirSync(site);
  writeFileSync(join(site, ".repowiki-site"), "");
  writeFileSync(join(site, "export.json"), `${JSON.stringify(sample.wiki, null, 2)}\n`);
  writeFileSync(join(site, "index.html"), "<p>main page</p>");
  writeFileSync(join(site, "404.html"), "<p>not found</p>");
});
afterAll(() => {
  sample.repo.remove();
  rmSync(out, { recursive: true, force: true });
});

/** The environment with no API key, as a session without one runs. */
const keyless = () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("ANTHROPIC_")) delete env[name];
  return env;
};

/** A running wiki:serve, the port it printed, and its stderr so far. */
async function serve(args: readonly string[], env = keyless()) {
  const child: ChildProcess = spawn(process.execPath, [SCRIPT, sample.repo.dir, ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setInterval(() => {
      const match = /serving http:\/\/127\.0\.0\.1:(\d+)\//.exec(stdout);
      if (match !== null) {
        clearInterval(timer);
        resolve(Number(match[1]));
      }
    }, 50);
    void exited.then(() => {
      clearInterval(timer);
      reject(new Error(`wiki:serve exited: ${stderr}`));
    });
  });
  return { child, port, exited, stderr: () => stderr, stdout: () => stdout };
}

const get = (port: number, path: string, host = `127.0.0.1:${port}`) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end();
  });

describe("wiki-serve.ts as a process", () => {
  it(
    "serves the site with routing only under --no-ask, and prints the session's total on SIGINT",
    async () => {
      const server = await serve(["--out", out, "--port", "0", "--no-ask"], {
        ...keyless(),
        ANTHROPIC_API_KEY: "sk-ant-test-not-a-key",
      });
      expect(server.stdout()).toMatch(
        new RegExp(
          `^serving http://127\\.0\\.0\\.1:\\d+/ \\(the wiki at ${sample.sha.slice(0, 7)}; Ctrl-C to stop\\)\\n$`,
        ),
      );
      expect(server.stderr()).toContain("ask: routing only (--no-ask)");
      expect(await get(server.port, "/")).toEqual({ status: 200, body: "<p>main page</p>" });
      expect(JSON.parse((await get(server.port, "/api/ask/status")).body)).toEqual({
        mode: "routing",
        head: sample.sha,
        reason: "disabled",
      });
      expect((await get(server.port, "/.repowiki-site")).status).toBe(404);
      expect((await get(server.port, "/", "evil.example")).status).toBe(421);
      server.child.kill("SIGINT");
      expect(await server.exited).toBe(0);
      expect(server.stderr()).toContain("0 questions, 0 cached, $0.0000");
      expect(server.stderr()).not.toContain("sk-ant");
      expect(existsSync(join(out, "ask"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "routes only, and says why, without an API key",
    async () => {
      const server = await serve(["--out", out, "--port", "0"]);
      expect(server.stderr()).toContain("ask: routing only (no ANTHROPIC_API_KEY)");
      expect(JSON.parse((await get(server.port, "/api/ask/status")).body).reason).toBe("no-key");
      server.child.kill("SIGTERM");
      expect(await server.exited).toBe(0);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "exits 2 naming --port when the port is in use",
    async () => {
      const busy = createServer();
      await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
      try {
        const port = (busy.address() as AddressInfo).port;
        const result = spawnSync(
          process.execPath,
          [SCRIPT, sample.repo.dir, "--out", out, "--port", String(port), "--no-ask"],
          { env: keyless(), encoding: "utf8", timeout: PROCESS_TIMEOUT_MS },
        );
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(`port ${port} is in use`);
        expect(result.stderr).toContain("--port");
      } finally {
        await new Promise((resolve) => busy.close(resolve));
      }
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "exits 1 with no export to serve, and 2 for an out dir inside the repository",
    () => {
      const empty = mkdtempSync(join(tmpdir(), "repowiki-serve-empty-"));
      try {
        const none = spawnSync(process.execPath, [SCRIPT, sample.repo.dir, "--out", empty], {
          env: keyless(),
          encoding: "utf8",
          timeout: PROCESS_TIMEOUT_MS,
        });
        expect(none.status).toBe(1);
        expect(none.stderr).toContain("run pnpm wiki:build first");
        const inside = spawnSync(
          process.execPath,
          [SCRIPT, sample.repo.dir, "--out", join(sample.repo.dir, "wiki")],
          { env: keyless(), encoding: "utf8", timeout: PROCESS_TIMEOUT_MS },
        );
        expect(inside.status).toBe(2);
        expect(inside.stderr).toContain("refusing to write inside the documented repository");
        expect(existsSync(join(sample.repo.dir, "wiki"))).toBe(false);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    },
    PROCESS_TIMEOUT_MS,
  );

  it("rebuilds the site first when its copy of the export is not the export's", async () => {
    const stale = mkdtempSync(join(tmpdir(), "repowiki-serve-stale-"));
    try {
      writeFileSync(join(stale, "export.json"), `${JSON.stringify(sample.wiki, null, 2)}\n`);
      const server = await serve(["--out", stale, "--port", "0", "--no-ask"]);
      expect(server.stderr()).toContain("building the site (export changed)");
      expect(readFileSync(join(stale, "site", "export.json"), "utf8")).toBe(
        `${JSON.stringify(sample.wiki, null, 2)}\n`,
      );
      const page = await get(server.port, "/wiki/signals/");
      expect(page.status).toBe(200);
      expect(page.body).toContain('id="claim-s-1"');
      server.child.kill("SIGINT");
      expect(await server.exited).toBe(0);
    } finally {
      rmSync(stale, { recursive: true, force: true });
    }
  }, 240_000);
});
