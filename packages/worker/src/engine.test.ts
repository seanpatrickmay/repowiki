import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeProvider, createLedger, resolveModels } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { COST_CAP_MARK, engineEnv, rebasedFetch, runCli } from "./engine.ts";

function script(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "cli-")), "cli.mjs");
  writeFileSync(path, body);
  return path;
}

const LLM_URL = "http://repowiki.internal:8787/llm";

describe("runCli (spec 2 S9)", () => {
  it("runs a script with exactly the environment given and keeps the end of stderr", async () => {
    const path = script(
      `process.stderr.write(JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env).sort() })); process.exit(3);`,
    );
    const run = await runCli({
      script: path,
      args: ["a", "b"],
      env: { PATH: "/usr/bin:/bin", HOME: "/h" },
      timeoutMs: 10_000,
    });
    expect(run).toMatchObject({ status: 3, timedOut: false, costCapped: false });
    const seen = JSON.parse(run.stderrTail);
    expect(seen.args).toEqual(["a", "b"]);
    expect(seen.env.filter((k: string) => !k.startsWith("__CF") && k !== "LC_CTYPE")).toEqual([
      "HOME",
      "PATH",
    ]);
  });

  it("gives node its own arguments, and keeps stdout only when asked, up to a limit", async () => {
    const path = script(
      `process.stdout.write(JSON.stringify({ execArgv: process.execArgv, size: Number(process.argv[2]) }) + "x".repeat(Number(process.argv[2])));`,
    );
    const nodeArgs = ["--max-old-space-size=64"];
    const run = (size: number, stdoutBytes?: number) =>
      runCli({
        script: path,
        args: [String(size)],
        env: {},
        timeoutMs: 10_000,
        nodeArgs,
        ...(stdoutBytes === undefined ? {} : { stdoutBytes }),
      });
    const kept = await run(10, 1000);
    expect(kept.status).toBe(0);
    expect(JSON.parse(String(kept.stdout).replace(/x+$/, ""))).toEqual({
      execArgv: nodeArgs,
      size: 10,
    });
    expect((await run(10)).stdout).toBeUndefined();
    expect((await run(100_000, 1000)).stdout).toBeNull();
  });

  it("kills a script that runs past its time limit", async () => {
    const run = await runCli({
      script: script("setTimeout(() => {}, 60_000);"),
      args: [],
      env: {},
      timeoutMs: 200,
    });
    expect(run).toMatchObject({ timedOut: true });
  });

  it("notices the proxy's cost refusal anywhere in stderr, not only in its tail", async () => {
    const path = script(
      `process.stderr.write('ingest: not written: the write call failed: LlmError: batch could not be created: 429 {"type":"error","error":{"type":"rate_limit_error","message":"job-cost-cap"}}\\n'); process.stderr.write("x".repeat(20000)); process.exit(0);`,
    );
    const run = await runCli({ script: path, args: [], env: {}, timeoutMs: 10_000 });
    expect(run).toMatchObject({ status: 0, costCapped: true });
    expect(run.stderrTail).not.toContain(COST_CAP_MARK);
    expect(run.stderrTail.length).toBe(4096);
  });
});

describe("the engine's environment (spec 2 S9, §10)", () => {
  it("holds the proxy and the job token as the Anthropic settings and nothing secret else", () => {
    const env = engineEnv({ home: "/w/home", llmUrl: LLM_URL, token: "tok" });
    expect(env).toMatchObject({
      HOME: "/w/home",
      ANTHROPIC_BASE_URL: LLM_URL,
      ANTHROPIC_API_KEY: "tok",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LC_ALL",
      "PATH",
    ]);
  });

  it("sends the worker's own model call to the proxy instead of Anthropic", async () => {
    const seen: string[] = [];
    const fetchFn = rebasedFetch(LLM_URL, async (input) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return new Response("{}");
    });
    await fetchFn("https://api.anthropic.com/v1/messages", { method: "POST" });
    await fetchFn(new URL("https://api.anthropic.com/v1/messages/batches"));
    await fetchFn(new Request("https://api.anthropic.com/v1/messages/batches/b1"));
    expect(seen).toEqual([
      `${LLM_URL}/v1/messages`,
      `${LLM_URL}/v1/messages/batches`,
      `${LLM_URL}/v1/messages/batches/b1`,
    ]);
  });
});

describe("the proxy's cost refusal as an engine CLI prints it (Review Focus 1)", () => {
  // The proxy's exact refusal (server routes/llm.ts capRefusal); retry-after-ms only keeps the
  // SDK's two retries quick.
  const refusal = async () =>
    new Response(
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "job-cost-cap" },
      }),
      { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" } },
    );
  const provider = () =>
    createClaudeProvider({
      models: resolveModels(),
      ledger: createLedger(),
      runId: "test",
      apiKey: "tok",
      fetch: rebasedFetch(LLM_URL, refusal),
    });
  const request = {
    purpose: "write" as const,
    system: "s",
    messages: [{ role: "user" as const, content: "u" }],
    schema: z.object({ a: z.string() }),
    maxTokens: 10,
  };

  it("keeps the refusal's message in the SDK's error, direct and batched", async () => {
    const direct = await provider()
      .generate(request)
      .catch((e: unknown) => e);
    expect(String((direct as Error).message)).toContain(COST_CAP_MARK);
    const batched = await provider()
      .generate({ ...request, batch: true })
      .catch((e: unknown) => e);
    expect(String((batched as Error).message)).toContain(COST_CAP_MARK);
  });
});
