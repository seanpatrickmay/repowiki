import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcp, MAX_STDERR_CHARS, McpClientError, type McpClientOptions } from "./client.ts";

const FAKE = fileURLToPath(new URL("./test-fake-server.ts", import.meta.url));
const TEST_TIMEOUT_MS = 20_000;

let dir: string;
let pidFiles = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "repowiki-client-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Options to launch the fake server in `mode`, and how to read the pid it wrote. */
const fake = (mode: string, extra: Partial<McpClientOptions> = {}) => {
  const pidFile = join(dir, `pid-${++pidFiles}`);
  return {
    options: { command: process.execPath, args: [FAKE, mode, pidFile], ...extra },
    pid: () => Number(readFileSync(pidFile, "utf8")),
  };
};

/** Whether process `pid` is gone, after waiting up to a second for it to go. */
const gone = async (pid: number) => {
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

describe("connectMcp", () => {
  it(
    "kills a server that does not answer initialize in time",
    async () => {
      const { options, pid } = fake("stall", { timeoutMs: 300 });
      await expect(connectMcp(options)).rejects.toThrow(
        new McpClientError("no reply to initialize within 300 ms"),
      );
      expect(await gone(pid())).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "kills a server whose initialize result is not one",
    async () => {
      const { options, pid } = fake("bad-init");
      await expect(connectMcp(options)).rejects.toThrow(
        "initialize: the MCP server's result is not valid",
      );
      expect(await gone(pid())).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ignores lines that are not replies to a request it sent, and logs them",
    async () => {
      const logged: string[] = [];
      const { options } = fake("noise", { log: (line) => logged.push(line) });
      const client = await connectMcp(options);
      try {
        expect(client.info).toEqual({
          protocolVersion: "2025-11-25",
          serverInfo: { name: "fake", version: "1" },
          instructions: "Scripted.",
        });
        // Each reply comes twice; the second is no one's, and the next call gets its own.
        expect(await client.callTool("echo", { n: 1 })).toEqual({
          text: 'echo {"n":1}',
          isError: false,
        });
        expect(await client.callTool("echo", { n: 2 })).toEqual({
          text: 'echo {"n":2}',
          isError: false,
        });
        expect(logged.length).toBeGreaterThanOrEqual(7);
        expect(logged.every((line) => !line.includes("\n"))).toBe(true);
      } finally {
        await client.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives up on a slow reply, ignores it when it comes late, and goes on",
    async () => {
      // Long enough for a loaded machine to start the server; the slow reply comes 4 s late.
      const { options } = fake("late", { timeoutMs: 2500 });
      const client = await connectMcp(options);
      try {
        await expect(client.callTool("echo", { slow: true })).rejects.toThrow(
          "no reply to tools/call within 2500 ms",
        );
        expect((await client.callTool("echo", { n: 2 })).text).toBe('echo {"n":2}');
        await new Promise((resolve) => setTimeout(resolve, 2000));
        expect((await client.callTool("echo", { n: 3 })).text).toBe('echo {"n":3}');
      } finally {
        await client.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "caps what it keeps of the server's stderr and of a line with no end in sight",
    async () => {
      const { options } = fake("flood");
      const client = await connectMcp(options);
      try {
        expect(client.stderr().length).toBeLessThanOrEqual(MAX_STDERR_CHARS);
        expect((await client.callTool("echo", {})).text).toBe("echo {}");
      } finally {
        await client.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "removes every ANTHROPIC_ variable from the server's environment",
    async () => {
      const saved = process.env.ANTHROPIC_FAKE_FOR_TEST;
      process.env.ANTHROPIC_FAKE_FOR_TEST = "x";
      try {
        for (const env of [undefined, { ...process.env, ANTHROPIC_API_KEY: "sk-test" }]) {
          const client = await connectMcp(fake("ok", { env }).options);
          const stderr = client.stderr();
          await client.close();
          expect(stderr).toContain("env: []\n");
        }
      } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_FAKE_FOR_TEST;
        else process.env.ANTHROPIC_FAKE_FOR_TEST = saved;
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "kills a server that answers with a protocol version it does not speak",
    async () => {
      const { options, pid } = fake("old");
      await expect(connectMcp(options)).rejects.toThrow(
        "the MCP server speaks protocol version 1999-01-01, which this client does not",
      );
      expect(await gone(pid())).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives the agent a tool's text as data: invisible characters marked, CRLF as LF",
    async () => {
      const client = await connectMcp(fake("hidden").options);
      try {
        expect((await client.callTool("echo", {})).text).toBe("a\uFFFDb\nc");
      } finally {
        await client.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "decodes a character split across two reads of the server's output",
    async () => {
      const client = await connectMcp(fake("split").options);
      try {
        expect(await client.callTool("echo", {})).toEqual({
          text: "caf\u00e9 au lait",
          isError: false,
        });
      } finally {
        await client.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("McpClient.close", () => {
  it(
    "resolves when the server has exited, though a child of it still holds its output open",
    async () => {
      const { options, pid } = fake("wrapper", { closeGraceMs: 200 });
      const client = await connectMcp(options);
      const child = Number(readFileSync(`${join(dir, `pid-${pidFiles}`)}.child`, "utf8"));
      try {
        const closed = await Promise.race([
          client.close(),
          new Promise((resolve) => setTimeout(() => resolve("pending"), 3000)),
        ]);
        expect(closed).toEqual({ code: null });
        expect(await gone(pid())).toBe(true);
      } finally {
        process.kill(child, "SIGKILL");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a call at once once the server's input has failed",
    async () => {
      const client = await connectMcp(fake("shut", { timeoutMs: 5000, closeGraceMs: 200 }).options);
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await expect(client.callTool("echo", { n: 1 })).rejects.toThrow(McpClientError);
        const started = Date.now();
        await expect(client.callTool("echo", { n: 2 })).rejects.toThrow(
          /^cannot write to the MCP server/,
        );
        expect(Date.now() - started).toBeLessThan(1000);
      } finally {
        await client.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ends the server's input and waits for it to exit",
    async () => {
      const client = await connectMcp(fake("ok").options);
      expect(await client.close()).toEqual({ code: 0 });
      await expect(client.callTool("echo", {})).rejects.toThrow(
        new McpClientError("the MCP client is closed"),
      );
      expect(await client.close()).toEqual({ code: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops a server that ignores the end of its input, then one that ignores SIGTERM",
    async () => {
      for (const mode of ["deaf", "stubborn"]) {
        const { options, pid } = fake(mode, { closeGraceMs: 200 });
        const client = await connectMcp(options);
        const pending = client.callTool("echo", {}).catch((error: unknown) => error);
        const closed = client.close();
        await expect(client.callTool("echo", {})).rejects.toThrow("the MCP client is closed");
        expect(await closed, mode).toEqual({ code: null });
        expect(await pending).toEqual(new McpClientError("the MCP client is closed"));
        expect(await gone(pid()), mode).toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
