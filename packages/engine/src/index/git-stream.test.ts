import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const real: typeof import("node:child_process") = await importOriginal();
  return { ...real, spawn };
});

const { GitError, streamBlobs } = await import("./git.ts");

const OID = (n: number) => n.toString(16).padStart(40, "0");
const header = (n: number, size: number) => `${OID(n)} blob ${size}\n`;

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  written: string[];
  /** The child ends its output and exits with `code`. */
  exit(code: number): void;
}

function fakeChild(highWaterMark?: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.written = [];
  child.stdin = new Writable({
    write(chunk: Buffer, _encoding, done) {
      child.written.push(chunk.toString("utf8"));
      done();
    },
  });
  child.stdout = new PassThrough({ highWaterMark });
  child.stderr = new PassThrough();
  child.exit = (code) => {
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit("close", code, null));
  };
  child.kill = vi.fn(() => {
    child.stdout.destroy();
    setImmediate(() => child.emit("close", null, "SIGKILL"));
    return true;
  });
  return child;
}

async function collect(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable);
}

afterEach(() => spawn.mockReset());

describe("streamBlobs against a scripted cat-file", () => {
  it("runs the pinned cat-file --batch in the scrubbed environment and feeds it the oids", async () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = "/somewhere/else";
    try {
      const child = fakeChild();
      spawn.mockReturnValue(child);
      child.stdout.write(`${header(1, 2)}hi\n${header(2, 0)}\n`);
      child.exit(0);
      const seen: string[] = [];
      for await (const blob of streamBlobs("/repo", [OID(1), OID(2)], 100)) {
        seen.push(blob.content?.toString("utf8") ?? "<none>");
      }
      expect(seen).toEqual(["hi", ""]);
      const [command, args, options] = spawn.mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];
      expect(command).toBe("git");
      expect(args).toEqual(["-C", "/repo", "cat-file", "--batch"]);
      expect(options.env.GIT_DIR).toBeUndefined();
      expect(options.env.GIT_NO_LAZY_FETCH).toBe("1");
      expect(child.written.join("")).toBe(`${OID(1)}\n${OID(2)}\n`);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  it("does not start git for no oids", async () => {
    await collect(streamBlobs("/repo", [], 100));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects output cut off inside a blob", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    child.stdout.write(`${header(1, 10)}abc`);
    child.exit(0);
    const attempt = collect(streamBlobs("/repo", [OID(1)], 100));
    await expect(attempt).rejects.toThrow(GitError);
    await expect(attempt).rejects.toThrow(/ended before the end of blob/);
  });

  it("rejects output cut off inside a header", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    child.stdout.write(`${OID(1)} bl`);
    child.exit(0);
    await expect(collect(streamBlobs("/repo", [OID(1)], 100))).rejects.toThrow(
      /ended inside a header/,
    );
  });

  it("rejects a clean end that is short of the requested blobs", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    child.stdout.write(`${header(1, 1)}a\n`);
    child.exit(0);
    await expect(collect(streamBlobs("/repo", [OID(1), OID(2)], 100))).rejects.toThrow(
      /ended after 1 of 2 blobs/,
    );
  });

  it("reports a child that exits early with git's own one-line message", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    child.stderr.write("fatal: boom\n");
    child.exit(128);
    const attempt = collect(streamBlobs("/repo", [OID(1)], 100));
    await expect(attempt).rejects.toThrow(GitError);
    await expect(attempt).rejects.toThrow("git cat-file failed in /repo: fatal: boom");
  });

  it("reports a child that dies after some blobs, not a truncation", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    child.stdout.write(`${header(1, 1)}a\n${header(2, 5)}ab`);
    child.stderr.write("fatal: disk gone\n");
    child.exit(128);
    const seen: string[] = [];
    const attempt = (async () => {
      for await (const blob of streamBlobs("/repo", [OID(1), OID(2)], 100)) {
        seen.push(blob.oid);
      }
    })();
    await expect(attempt).rejects.toThrow("git cat-file failed in /repo: fatal: disk gone");
    expect(seen).toEqual([OID(1)]);
  });

  it("reports a git that cannot start", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    setImmediate(() => {
      child.emit("error", new Error("spawn git ENOENT"));
      child.stdout.destroy();
    });
    await expect(collect(streamBlobs("/repo", [OID(1)], 100))).rejects.toThrow(
      /could not run git: .*ENOENT/,
    );
  });

  it.each([
    ["a missing object", `${OID(1)} missing\n`],
    ["an unexpected type", `${OID(1)} tree 3\nabc\n`],
    ["a bad size", `${OID(1)} blob -1\n`],
  ])("rejects %s with GitError", async (_name, output) => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    child.stdout.write(output);
    child.exit(0);
    const attempt = collect(streamBlobs("/repo", [OID(1)], 100));
    await expect(attempt).rejects.toThrow(GitError);
    await expect(attempt).rejects.toThrow(/unexpected cat-file header/);
  });

  it("stops git and closes its input when the consumer stops early", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    child.stdout.write(`${header(1, 1)}a\n${header(2, 1)}b\n`);
    for await (const blob of streamBlobs("/repo", [OID(1), OID(2)], 100)) {
      expect(blob.oid).toBe(OID(1));
      break;
    }
    expect(child.kill).toHaveBeenCalled();
    expect(child.stdin.destroyed || child.stdin.writableEnded).toBe(true);
  });

  it("does not read ahead of a slow consumer", async () => {
    const child = fakeChild(16 * 1024);
    spawn.mockReturnValue(child);
    const body = Buffer.alloc(1024, 0x61);
    const blobs = 2000;
    let produced = 0;
    const pump = (): void => {
      while (produced < blobs) {
        produced++;
        const ok = child.stdout.write(
          Buffer.concat([Buffer.from(header(1, 1024)), body, Buffer.from("\n")]),
        );
        if (!ok) return void child.stdout.once("drain", pump);
      }
      child.exit(0);
    };
    pump();
    const it = streamBlobs("/repo", Array<string>(blobs).fill(OID(1)), 4096);
    await it.next();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 2000 blobs are 2 MB; a stream that ignores backpressure would have taken all of it.
    expect(produced).toBeLessThan(300);
    let count = 1;
    for await (const _ of it) count++;
    expect(count).toBe(blobs);
  });

  it("counts the lines of a 512 MiB blob as it streams, never holding or allocating it whole", async () => {
    const child = fakeChild(64 * 1024);
    spawn.mockReturnValue(child);
    const size = 512 * 1024 * 1024;
    const chunkSize = 64 * 1024;
    const allocated: number[] = [];
    const spies = (["concat", "alloc", "allocUnsafe", "allocUnsafeSlow"] as const).map((name) => {
      const original = Buffer[name] as (...args: unknown[]) => Buffer;
      return vi.spyOn(Buffer, name).mockImplementation(((...args: unknown[]) => {
        const out = original.apply(Buffer, args);
        allocated.push(out.length);
        return out;
      }) as never);
    });
    try {
      // "xxxxxxx\n" lines of 8 bytes: 64Ki newlines in every chunk, none at all after the last
      // byte, which is a newline too.
      const line = Buffer.from("xxxxxxx\n");
      const chunk = Buffer.alloc(chunkSize);
      for (let i = 0; i < chunkSize; i += line.length) line.copy(chunk, i);
      let sent = 0;
      child.stdout.write(header(1, size));
      const pump = (): void => {
        while (sent < size) {
          sent += chunkSize;
          if (!child.stdout.write(Buffer.from(chunk))) return void child.stdout.once("drain", pump);
        }
        child.stdout.write("\n");
        child.exit(0);
      };
      pump();
      const seen = [];
      for await (const blob of streamBlobs("/repo", [OID(1)], 1024 * 1024)) seen.push(blob);
      expect(seen).toHaveLength(1);
      const [blob] = seen;
      expect(blob?.size).toBe(size);
      expect(blob?.content).toBeNull();
      expect(blob?.head.length).toBe(8000);
      expect(blob?.lines).toBe(size / 8);
      expect(Math.max(...allocated)).toBeLessThan(1024 * 1024);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }, 60_000);
});
