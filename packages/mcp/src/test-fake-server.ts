/**
 * Test-only: a scripted MCP server for client.ts's tests, run as
 * `node test-fake-server.ts <mode> [pid file]`. It writes its pid to the file, and the names of
 * the ANTHROPIC_ variables it sees to stderr, then answers by mode:
 * - ok: initialize, tools/list (one tool, echo) and tools/call; exits when stdin ends.
 * - stall: never answers.
 * - bad-init: answers initialize with a result that is not an initialize result.
 * - noise: writes lines that are not replies to it (null, garbage, a server request with the
 *   same id, an id with neither result nor error, an unknown id) before each reply, and every
 *   tools/call reply twice.
 * - late: answers a tools/call whose arguments have `slow` 4 s late.
 * - flood: writes 1 MiB to stderr and a 5 MiB line with no reply in it before answering.
 * - deaf: answers only initialize, and ignores the end of stdin.
 * - stubborn: as deaf, and ignores SIGTERM too.
 * - split: writes each tools/call reply in two writes 50 ms apart, split inside a two-byte
 *   character, so the client reads it in two chunks.
 * - wrapper: as deaf, and starts a child that holds its stdout and stderr open for 30 s (its pid
 *   in `<pid file>.child`), as a wrapper command's server would.
 * - shut: closes its stdin after answering initialize, and stays alive.
 * - old: answers initialize with a protocol version no client speaks.
 * - hidden: answers tools/call with text holding a bidi override and a CRLF.
 */
import { spawn } from "node:child_process";
import { closeSync, writeFileSync } from "node:fs";

const [mode = "ok", pidFile] = process.argv.slice(2);
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));
const send = (message: unknown) =>
  process.stdout.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
const seen = Object.keys(process.env).filter((name) => name.startsWith("ANTHROPIC_"));
process.stderr.write(`env: ${JSON.stringify(seen)}\n`);
const ignoresEnd = mode === "deaf" || mode === "stubborn" || mode === "wrapper" || mode === "shut";
if (mode === "wrapper") {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (pidFile !== undefined) writeFileSync(`${pidFile}.child`, String(child.pid));
}
if (mode === "stubborn") process.on("SIGTERM", () => {});
if (ignoresEnd) setInterval(() => {}, 1000);

type Message = { id?: number; method?: string; params?: { arguments?: { slow?: boolean } } };

const noise = (id: number) => {
  for (const line of [
    "null",
    "not json",
    "[1]",
    '"text"',
    JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }),
    JSON.stringify({ jsonrpc: "2.0", id }),
    JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }),
  ]) {
    send(line);
  }
};

function handle(message: Message): void {
  const { id, method } = message;
  if (id === undefined || mode === "stall") return;
  if (mode === "noise") noise(id);
  if (method === "initialize") {
    if (mode === "flood") {
      process.stderr.write("e".repeat(1024 * 1024));
      process.stdout.write("x".repeat(5 * 1024 * 1024));
      send("");
    }
    if (mode === "bad-init")
      return void send({ jsonrpc: "2.0", id, result: { protocolVersion: 5 } });
    if (mode === "old") {
      const serverInfo = { name: "fake", version: "1" };
      return void send({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: "1999-01-01", serverInfo },
      });
    }
    if (mode === "shut") {
      setTimeout(() => {
        process.stdin.destroy();
        closeSync(0);
      }, 50);
    }
    return void send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "fake", version: "1" },
        instructions: "Scripted.",
      },
    });
  }
  if (ignoresEnd) return;
  if (method === "tools/list") {
    const tools = [{ name: "echo", description: "Echoes.", inputSchema: { type: "object" } }];
    return void send({ jsonrpc: "2.0", id, result: { tools } });
  }
  if (method === "tools/call") {
    const args = message.params?.arguments;
    const reply = {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `echo ${JSON.stringify(args)}` }] },
    };
    if (mode === "hidden") {
      reply.result.content[0] = { type: "text", text: "a\u202Eb\r\nc" };
    }
    if (mode === "split") {
      reply.result.content[0] = { type: "text", text: "caf\u00e9 au lait" };
      const bytes = Buffer.from(`${JSON.stringify(reply)}\n`, "utf8");
      const at = bytes.indexOf(0xc3) + 1;
      process.stdout.write(bytes.subarray(0, at));
      setTimeout(() => process.stdout.write(bytes.subarray(at)), 50);
      return;
    }
    if (mode === "late" && args?.slow === true) {
      setTimeout(() => send(reply), 4000);
      return;
    }
    send(reply);
    if (mode === "noise") send(reply);
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    handle(JSON.parse(line) as Message);
  }
});
process.stdin.on("end", () => {
  if (!ignoresEnd) process.exit(0);
});
