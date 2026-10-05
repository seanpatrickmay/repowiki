import { INVALID_REQUEST, type Protocol } from "./protocol.ts";

/** The longest request line read, in bytes; a longer one is refused and dropped (R17). */
export const MAX_LINE_BYTES = 1024 * 1024;

/** The most lines read but not yet answered; past it, input is paused until replies catch up. */
export const MAX_QUEUED_LINES = 64;

/** JSON-RPC's internal error code: handling a line threw. */
const INTERNAL_ERROR = -32603;

/** The id of a request line, when it has a usable one; null otherwise. */
function idOf(line: string): string | number | null {
  try {
    const id = (JSON.parse(line) as { id?: unknown } | null)?.id;
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

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
  /** Where replies go. A write that returns false waits for "drain" (or "close"/"error"). */
  output: {
    write(text: string): unknown;
    once?(event: "drain" | "close" | "error", listener: () => void): unknown;
    off?(event: "drain" | "close" | "error", listener: () => void): unknown;
  };
  maxLineBytes?: number;
}

/** Resolves once `output` takes writes again, or never will (it closed or failed). */
function drained(output: StdioOptions["output"]): Promise<void> {
  const { once, off } = output;
  if (once === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      for (const event of ["drain", "close", "error"] as const) off?.call(output, event, done);
      resolve();
    };
    for (const event of ["drain", "close", "error"] as const) once.call(output, event, done);
  });
}

/**
 * Serves `protocol` over newline-delimited JSON (the MCP stdio transport): each UTF-8 line of
 * input is one message (a trailing CR dropped, blank lines skipped), handled one at a time in
 * arrival order, each reply written as one line. A line over `maxLineBytes` is answered with
 * -32600 and dropped up to its end; a line whose handling throws is answered with -32603, and
 * the session goes on. Input is paused while more than MAX_QUEUED_LINES lines wait, which is the
 * case while a reply waits for the output to drain. Resolves when the input ends and every reply
 * is written. Nothing else may write to the output.
 */
export function serveStdio(protocol: Protocol, options: StdioOptions): Promise<void> {
  const max = options.maxLineBytes ?? MAX_LINE_BYTES;
  let pending: Buffer[] = [];
  let size = 0;
  let dropping = false;
  let queue = Promise.resolve();
  let waiting = 0;
  /** The first failure to write a reply; the session ends with it. */
  let failure: { error: unknown } | null = null;
  let paused = false;
  const reply = async (message: object | null) => {
    if (message !== null && options.output.write(encodeMessage(message)) === false) {
      await drained(options.output);
    }
  };
  /** Queues one step; a step's failure never stops the steps after it. */
  const later = (step: () => Promise<void>) => {
    waiting++;
    if (waiting > MAX_QUEUED_LINES && !paused) {
      paused = true;
      options.input.pause();
    }
    queue = queue
      .then(step)
      .catch((error: unknown) => {
        failure ??= { error };
      })
      .finally(() => {
        waiting--;
        if (paused && waiting <= MAX_QUEUED_LINES / 2) {
          paused = false;
          options.input.resume();
        }
      });
  };
  const enqueue = (line: string) => {
    later(async () => {
      let message: object | null;
      try {
        message = await protocol.handleLine(line);
      } catch {
        message = {
          jsonrpc: "2.0",
          id: idOf(line),
          error: { code: INTERNAL_ERROR, message: "internal error" },
        };
      }
      await reply(message);
    });
  };
  const tooLong = () => {
    later(() =>
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
      void queue.then(() => (failure === null ? resolve() : reject(failure.error)));
    });
  });
}
