import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcp, McpClientError, mcpToolSet } from "@repowiki/mcp";
import { type HistoryWiki, historyWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseServeArgs, prepareEnvironment, registrationHelp } from "./mcp-cli.ts";

const SCRIPT = "scripts/mcp-serve.ts";
/** Spawning node and loading the engine takes a few seconds on a loaded machine. */
const PROCESS_TIMEOUT_MS = 30_000;

let h: HistoryWiki;
let out: string;
beforeAll(() => {
  h = historyWiki();
  out = mkdtempSync(join(tmpdir(), "repowiki-mcp-out-"));
  writeFileSync(join(out, "export.json"), JSON.stringify(h.wiki));
});
afterAll(() => {
  h.repo.remove();
  rmSync(out, { recursive: true, force: true });
});

/** The environment a client gives the server, with a key in it the server must drop. */
const clientEnv = () => ({ ...process.env, ANTHROPIC_API_KEY: "sk-ant-test-not-a-key" });

/** Every file under `dir` with its size and mtime, so a test can prove nothing was written. */
function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => {
      const path = join(e.parentPath, e.name);
      const stat = statSync(path);
      return `${path} ${e.isFile() ? stat.size : "dir"} ${stat.mtimeMs}`;
    })
    .sort();
}

/** A running server, and a way to send it one request and wait for its reply. */
function start(args: readonly string[]) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SCRIPT, ...args], {
    env: clientEnv(),
  });
  let stdout = "";
  let stderr = "";
  const waiting = new Map<number, (reply: unknown) => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    for (const line of stdout.split("\n").slice(0, -1)) {
      const reply = JSON.parse(line) as { id: number };
      waiting.get(reply.id)?.(reply);
      waiting.delete(reply.id);
    }
    stdout = stdout.slice(stdout.lastIndexOf("\n") + 1);
  });
  const lines: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let id = 0;
  return {
    request(
      method: string,
      params?: unknown,
    ): Promise<{ result?: { content?: { text: string }[] } }> {
      id++;
      const reply = new Promise<never>((resolve) => waiting.set(id, resolve as never));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return reply;
    },
    notify(method: string) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    async end(): Promise<{ code: number | null; stderr: string; stdout: string }> {
      child.stdin.end();
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      return { code, stderr, stdout: lines.join("") };
    },
  };
}

const textOf = (reply: { result?: { content?: { text: string }[] } }) =>
  reply.result?.content?.[0]?.text ?? "";

describe("mcp-serve.ts as a process (no network, no LLM)", () => {
  it(
    "serves a whole session over stdio, writing only protocol lines and one start line, and nothing to disk",
    async () => {
      const before = [...listing(join(h.repo.dir, ".git")), ...listing(out)];
      const server = start([h.repo.dir, "--out", out]);
      const init = await server.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(init).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
      server.notify("notifications/initialized");
      const list = (await server.request("tools/list")) as {
        result: { tools: { name: string }[] };
      };
      expect(list.result.tools.map((t) => t.name)).toEqual([
        "search",
        "list_pages",
        "read_page",
        "pages_for_file",
        "cited_code",
        "page_changes",
      ]);
      expect(
        textOf(await server.request("tools/call", { name: "list_pages", arguments: {} })),
      ).toContain("Wiki of sample: commit 3d751d3 (2026-01-04)");
      expect(
        textOf(
          await server.request("tools/call", {
            name: "cited_code",
            arguments: { id: "signals", ref: 2 },
          }),
        ),
      ).toContain("the cited lines changed");
      const done = await server.end();
      expect(done.code).toBe(0);
      for (const line of done.stdout.split("\n").filter((l) => l !== "")) {
        expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
      }
      expect(done.stderr.split("\n").filter((l) => l !== "")).toEqual([
        `repowiki mcp: serving the wiki of sample at commit 3d751d3 (2026-01-04) from ${out}; comparing with HEAD`,
      ]);
      expect([...listing(join(h.repo.dir, ".git")), ...listing(out)]).toEqual(before);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "serves an export replaced mid-session on the next call",
    async () => {
      const server = start([h.repo.dir, "--out", out, "--compare-to", h.sha]);
      const first = textOf(
        await server.request("tools/call", { name: "list_pages", arguments: {} }),
      );
      expect(first).toContain("exported 2026-10-04");
      const temporary = join(out, "export.json.tmp");
      writeFileSync(temporary, JSON.stringify({ ...h.wiki, exportedAt: "2026-10-05T00:00:00Z" }));
      renameSync(temporary, join(out, "export.json"));
      try {
        const second = textOf(
          await server.request("tools/call", { name: "list_pages", arguments: {} }),
        );
        expect(second).toContain("exported 2026-10-05");
        writeFileSync(temporary, "{ not json");
        renameSync(temporary, join(out, "export.json"));
        const third = textOf(
          await server.request("tools/call", { name: "list_pages", arguments: {} }),
        );
        expect(third).toContain("exported 2026-10-05");
        expect(third).toContain("The export changed but could not be read");
      } finally {
        writeFileSync(join(out, "export.json"), JSON.stringify(h.wiki));
      }
      const done = await server.end();
      expect(done.code).toBe(0);
      expect(done.stderr).toContain("repowiki mcp: reloaded the export: commit 3d751d3");
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "exits 1 with one line when there is no export, and 2 on a usage error",
    () => {
      const empty = mkdtempSync(join(tmpdir(), "repowiki-mcp-empty-"));
      try {
        const missing = spawnSync(process.execPath, [SCRIPT, h.repo.dir, "--out", empty], {
          env: clientEnv(),
          input: "",
          encoding: "utf8",
        });
        expect(missing.status).toBe(1);
        expect(missing.stdout).toBe("");
        expect(missing.stderr.trim().split("\n")).toHaveLength(1);
        expect(missing.stderr).toMatch(/^repowiki mcp: cannot read export .*export\.json/);
        const usage = spawnSync(process.execPath, [SCRIPT, h.repo.dir, "--bogus"], {
          encoding: "utf8",
        });
        expect(usage.status).toBe(2);
        const badRev = spawnSync(
          process.execPath,
          [SCRIPT, h.repo.dir, "--out", out, "--compare-to", "nope"],
          {
            encoding: "utf8",
          },
        );
        expect(badRev.status).toBe(2);
        expect(badRev.stderr).toContain("--compare-to nope names no commit");
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "prints the registration line with absolute paths for --help",
    () => {
      const help = spawnSync(process.execPath, [SCRIPT, "--help", h.repo.dir], {
        encoding: "utf8",
      });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain(
        `  claude mcp add --scope local repowiki -- node ${join(process.cwd(), SCRIPT)} ${h.repo.dir}\n`,
      );
    },
    PROCESS_TIMEOUT_MS,
  );
});

describe("mcp-cli", () => {
  it("parses a repo with --out and --compare-to, or --help alone, and refuses the rest", () => {
    expect(parseServeArgs(["repo", "--out", "o", "--compare-to", "abc"])).toEqual({
      repo: "repo",
      out: "o",
      compareTo: "abc",
      help: false,
    });
    expect(parseServeArgs(["--help"])).toMatchObject({ repo: null, help: true });
    for (const bad of [
      [],
      ["a", "b"],
      ["a", "--out", "x", "--out", "y"],
      ["a", "--out", ""],
      ["a", "-x"],
    ]) {
      expect(() => parseServeArgs(bad), bad.join(" ")).toThrow(
        /usage: node scripts\/mcp-serve\.ts/,
      );
    }
  });

  it("quotes a path that needs it in the registration line", () => {
    expect(registrationHelp("/r/scripts/mcp-serve.ts", "/home/me/my repo", null)).toContain(
      "claude mcp add --scope local repowiki -- node /r/scripts/mcp-serve.ts '/home/me/my repo'\n",
    );
    expect(registrationHelp("/r/s.ts", null, null)).toContain("node /r/s.ts /abs/path/to/repo\n");
  });

  it("drops every ANTHROPIC_ variable and sets GIT_OPTIONAL_LOCKS=0", () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_BASE_URL: "u",
      PATH: "/bin",
    };
    prepareEnvironment(env);
    expect(env).toEqual({ PATH: "/bin", GIT_OPTIONAL_LOCKS: "0" });
    expect(readFileSync(SCRIPT, "utf8").indexOf("prepareEnvironment(process.env)")).toBeLessThan(
      readFileSync(SCRIPT, "utf8").indexOf("parseServeArgs("),
    );
  });
});

describe("connectMcp and mcpToolSet (client.ts)", () => {
  it(
    "initializes a spawned server and serves its six tools as an agent's ToolSet",
    async () => {
      const client = await connectMcp({
        command: process.execPath,
        args: [SCRIPT, h.repo.dir, "--out", out, "--compare-to", h.sha],
        env: clientEnv(),
      });
      try {
        expect(client.info).toMatchObject({
          protocolVersion: "2025-11-25",
          serverInfo: { name: "repowiki", title: "RepoWiki" },
        });
        expect(client.info.instructions).toContain("at commit 3d751d3 (2026-01-04)");
        const tools = await mcpToolSet(client);
        expect(tools.definitions.map((d) => d.name)).toEqual([
          "search",
          "list_pages",
          "read_page",
          "pages_for_file",
          "cited_code",
          "page_changes",
        ]);
        expect(Object.keys(tools.definitions[0] ?? {})).toEqual([
          "name",
          "description",
          "inputSchema",
        ]);
        expect((await tools.run("read_page", { id: "signals" })).text).toMatch(
          /^Signal ingestion \(page id: signals\)\n/,
        );
        expect(await tools.run("read_page", {})).toMatchObject({ isError: true });
        expect(await tools.run("grep", {})).toEqual({
          text: "no tool named grep; the tools are search, list_pages, read_page, pages_for_file, cited_code, page_changes",
          isError: true,
        });
      } finally {
        expect(await client.close()).toEqual({ code: 0 });
      }
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "fails with the server's last stderr line when it exits before answering",
    async () => {
      const empty = mkdtempSync(join(tmpdir(), "repowiki-mcp-empty-"));
      try {
        await expect(
          connectMcp({
            command: process.execPath,
            args: [SCRIPT, h.repo.dir, "--out", empty],
            env: clientEnv(),
          }),
        ).rejects.toThrow(McpClientError);
        await expect(
          connectMcp({
            command: process.execPath,
            args: [SCRIPT, h.repo.dir, "--out", empty],
            env: clientEnv(),
          }),
        ).rejects.toThrow(/^the MCP server exited \(code 1\): repowiki mcp: cannot read export/);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    },
    PROCESS_TIMEOUT_MS,
  );
});
