import { INVALID_REQUEST, type Protocol } from "./protocol.ts";

/** The longest request line read, in bytes; a longer one is refused and dropped (R17). */
export const MAX_LINE_BYTES = 1024 * 1024;

/**
 * One JSON-RPC message as one line of output: JSON.stringify never writes a raw newline, and
 * U+2028 and U+2029 are escaped, so no reader that splits on line terminators sees two lines.
 */
export function encodeMessage(message: object): string {
  return `${JSON.stringify(message)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")}\n`;
}

export interface StdioOptions {
  input: NodeJS.ReadableStream;
  output: { write(text: string): unknown };
  maxLineBytes?: number;
}

/**
 * Serves `protocol` over newline-delimited JSON (the MCP stdio transport): each UTF-8 line of
 * input is one message (a trailing CR dropped, blank lines skipped), handled one at a time in
 * arrival order, each reply written as one line. A line over `maxLineBytes` is answered with
 * -32600 and dropped up to its end. Resolves when the input ends and every reply is written.
 * Nothing else may write to the output.
 */
export function serveStdio(protocol: Protocol, options: StdioOptions): Promise<void> {
  const max = options.maxLineBytes ?? MAX_LINE_BYTES;
  let pending: Buffer[] = [];
  let size = 0;
  let dropping = false;
  let queue = Promise.resolve();
  const reply = (message: object | null) => {
    if (message !== null) options.output.write(encodeMessage(message));
  };
  const enqueue = (line: string) => {
    queue = queue.then(async () => reply(await protocol.handleLine(line)));
  };
  const tooLong = () => {
    queue = queue.then(() =>
      reply({
        jsonrpc: "2.0",
        id: null,
        error: { code: INVALID_REQUEST, message: `request line over ${max} bytes; it was dropped` },
      }),
    );
  };
  const take = (chunk: Buffer) => {
    let start = 0;
    for (let nl = chunk.indexOf(0x0a, start); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (dropping) {
        dropping = false;
        continue;
      }
      if (size + piece.length > max) {
        pending = [];
        size = 0;
        tooLong();
        continue;
      }
      const line = Buffer.concat([...pending, piece])
        .toString("utf8")
        .replace(/\r$/, "");
      pending = [];
      size = 0;
      if (line.trim() !== "") enqueue(line);
    }
    if (dropping) return;
    const rest = chunk.subarray(start);
    if (size + rest.length > max) {
      pending = [];
      size = 0;
      dropping = true;
      tooLong();
      return;
    }
    if (rest.length > 0) {
      pending.push(rest);
      size += rest.length;
    }
  };
  return new Promise((resolve, reject) => {
    options.input.on("data", (chunk: Buffer | string) =>
      take(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    options.input.on("error", reject);
    options.input.on("end", () => {
      const line = Buffer.concat(pending).toString("utf8").replace(/\r$/, "");
      if (!dropping && line.trim() !== "") enqueue(line);
      queue.then(resolve, reject);
    });
  });
}
