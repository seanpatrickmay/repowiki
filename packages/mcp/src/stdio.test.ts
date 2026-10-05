import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { Protocol } from "./protocol.ts";
import { MAX_QUEUED_LINES, serveStdio } from "./stdio.ts";

const request = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
const answer = async (line: string) => ({
  jsonrpc: "2.0",
  id: (JSON.parse(line) as { id: unknown }).id,
  result: {},
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);
afterEach(() => {
  process.off("unhandledRejection", onRejection);
  rejections.length = 0;
});

describe("serveStdio", () => {
  it("answers a line whose handling throws with -32603, and goes on", async () => {
    process.on("unhandledRejection", onRejection);
    let thrown = 0;
    const protocol: Protocol = {
      handle: async () => null,
      handleLine: async (line) => {
        if (line.includes('"id":2')) {
          thrown++;
          throw new Error("instructions failed");
        }
        return answer(line);
      },
    };
    const input = new PassThrough();
    let out = "";
    const done = serveStdio(protocol, { input, output: { write: (t: string) => (out += t) } });
    input.write(`${request(1)}\n${request(2)}\n`);
    await tick();
    await tick();
    input.write(`${request(3)}\nnot json\n`);
    input.end();
    await done;
    await tick();
    expect(thrown).toBe(1);
    expect(
      out
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "internal error" } },
      { jsonrpc: "2.0", id: 3, result: {} },
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } },
    ]);
    expect(rejections).toEqual([]);
  });

  it("stops reading while replies wait for the output to drain, and reads on after", async () => {
    let handled = 0;
    const protocol: Protocol = {
      handle: async () => null,
      handleLine: async (line) => {
        handled++;
        return answer(line);
      },
    };
    // An output that is always full: each write waits for a drain the test gives by hand.
    const output = Object.assign(new EventEmitter(), {
      lines: [] as string[],
      write(text: string) {
        this.lines.push(text);
        return false;
      },
    });
    const input = new PassThrough();
    const done = serveStdio(protocol, { input, output });
    const total = MAX_QUEUED_LINES * 3;
    for (let id = 1; id <= total; id++) input.write(`${request(id)}\n`);
    for (let i = 0; i < 5; i++) await tick();
    expect(handled).toBe(1);
    expect(input.isPaused()).toBe(true);
    // The rest wait in the input stream, not in the server's queue.
    expect(input.readableLength).toBeGreaterThan(0);
    input.end();
    while (output.lines.length < total) {
      output.emit("drain");
      await tick();
    }
    output.emit("drain");
    await done;
    expect(handled).toBe(total);
    expect(output.lines.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
  });
});
