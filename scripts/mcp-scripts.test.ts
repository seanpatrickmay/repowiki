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
import {
  parseProbeArgs,
  parseServeArgs,
  prepareEnvironment,
  probeReport,
  registrationHelp,
  runProbe,
  startLine,
} from "./mcp-cli.ts";

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
  it("keeps a hostile repository name on the start line short and on one line", () => {
    const line = startLine({
      repo: `evil\nname\u202E${"x".repeat(300)}`,
      head: "3d751d3".padEnd(40, "0"),
      headDate: "2026-01-04",
      out: "/out",
      pinned: null,
    });
    expect(line).toMatch(
      /^repowiki mcp: serving the wiki of evil name\uFFFDx+\u2026 at commit 3d751d3 \(2026-01-04\) from \/out; comparing with HEAD$/,
    );
    expect([...line].length).toBeLessThanOrEqual(300);
    expect(
      startLine({
        repo: "sample",
        head: "a".repeat(40),
        headDate: null,
        out: "/o",
        pinned: "b".repeat(40),
      }),
    ).toBe(
      "repowiki mcp: serving the wiki of sample at commit aaaaaaa from /o; comparing with commit bbbbbbb",
    );
  });

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

describe("mcp-probe", () => {
  it("runs the fixed calls and reports each one's time and size", async () => {
    const asked: string[] = [];
    let t = 0;
    const rows = await runProbe(
      async () => ({
        listTools: async () => [{ name: "search" }],
        callTool: async (name, args) => {
          asked.push(`${name} ${JSON.stringify(args)}`);
          if (name === "list_pages")
            return { text: "Pages:\n- special:about: x\n- signals: S.\n", isError: false };
          if (name === "read_page")
            return {
              text: "Page history, oldest first: 2026-01-02 commit a (build)\n",
              isError: false,
            };
          return { text: "No page matches; try other words.\n", isError: false };
        },
      }),
      () => (t += 10),
    );
    expect(asked).toEqual([
      "list_pages {}",
      'search {"query":"how does it start"}',
      'search {"query":"configuration"}',
      'search {"query":"tests"}',
      'read_page {"id":"signals"}',
      'cited_code {"id":"signals","ref":1}',
      'read_page {"id":"signals","as_of":"2026-01-02"}',
      'page_changes {"id":"signals"}',
    ]);
    expect(rows.map((r) => r.ms)).toEqual(Array(10).fill(10));
    const report = probeReport(rows, 12_000);
    expect(report.split("\n")[0]).toBe("      ms  code points  error  call");
    expect(report).toContain("      10            -      -  start to initialize\n");
    expect(report).toContain(
      "slowest tool call: 10 ms (list_pages); largest result: 56 code points (the cap is 12,000); errors: 0\n",
    );
  });

  it("reports an error result and a rejected call as error rows, and goes on", async () => {
    const asked: string[] = [];
    const rows = await runProbe(
      async () => ({
        listTools: async () => {
          throw new McpClientError("tools/list: method not found");
        },
        callTool: async (name, args) => {
          asked.push(name);
          const query = (args as { query?: string }).query;
          if (query === "configuration")
            throw new McpClientError("no reply to tools/call within 30000 ms");
          if (query === "tests") return { text: "invalid input\n", isError: true };
          if (name === "list_pages") return { text: "- signals: S.\n", isError: false };
          return { text: "x\n", isError: false };
        },
      }),
      () => 0,
    );
    expect(asked).toEqual([
      "list_pages",
      "search",
      "search",
      "search",
      "read_page",
      "cited_code",
      "page_changes",
    ]);
    expect(rows.map((r) => [r.call, r.isError, r.problem ?? null])).toEqual([
      ["start to initialize", null, null],
      ["tools/list", true, "tools/list: method not found"],
      ["list_pages", false, null],
      ['search "how does it start"', false, null],
      ['search "configuration"', true, "no reply to tools/call within 30000 ms"],
      ['search "tests"', true, null],
      ["read_page signals", false, null],
      ["cited_code signals 1", false, null],
      ["page_changes signals", false, null],
    ]);
    const report = probeReport(rows, 12_000);
    expect(report).toContain(
      '       0            -    yes  search "configuration": no reply to tools/call within 30000 ms\n',
    );
    expect(report).toMatch(/errors: 3\n$/);
  });

  it("says so in every row left when the server dies mid-run", async () => {
    let dead = false;
    const rows = await runProbe(
      async () => ({
        listTools: async () => [],
        callTool: async (name) => {
          if (dead) throw new McpClientError("the MCP server has exited");
          if (name === "read_page") {
            dead = true;
            throw new McpClientError("the MCP server exited (code 1): repowiki mcp: boom");
          }
          return { text: "- signals: S.\n", isError: false };
        },
      }),
      () => 0,
    );
    expect(rows.slice(-3).map((r) => [r.call, r.problem])).toEqual([
      ["read_page signals", "the MCP server exited (code 1): repowiki mcp: boom"],
      ["cited_code signals 1", "the MCP server has exited"],
      ["page_changes signals", "the MCP server has exited"],
    ]);
  });

  it("parses <repo> [--out dir] and refuses the rest", () => {
    expect(parseProbeArgs(["r", "--out", "o"])).toEqual({ repo: "r", out: "o" });
    for (const bad of [[], ["a", "b"], ["a", "--out", ""], ["a", "--x"]]) {
      expect(() => parseProbeArgs(bad), bad.join(" ")).toThrow(/usage: pnpm mcp:probe/);
    }
  });

  it(
    "probes the fixture's server end to end as a process",
    () => {
      const before = listing(out);
      const probe = spawnSync(
        process.execPath,
        ["scripts/mcp-probe.ts", h.repo.dir, "--out", out],
        {
          env: clientEnv(),
          encoding: "utf8",
        },
      );
      expect(probe.status, probe.stderr).toBe(0);
      const lines = probe.stdout.trim().split("\n");
      expect(lines.slice(1, 11).map((l) => l.slice(30))).toEqual([
        "start to initialize",
        "tools/list",
        "list_pages",
        'search "how does it start"',
        'search "configuration"',
        'search "tests"',
        "read_page signals",
        "cited_code signals 1",
        "read_page signals as_of 2026-01-02",
        "page_changes signals",
      ]);
      expect(probe.stdout).toMatch(/errors: 0\n$/);
      expect(listing(out)).toEqual(before);
    },
    PROCESS_TIMEOUT_MS,
  );
});
