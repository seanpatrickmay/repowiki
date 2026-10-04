import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CassetteMissError, cassetteFetch, cassetteMode, type FetchLike } from "./cassette.ts";

const dirs: string[] = [];
function tempCassette(): string {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-cassette-"));
  dirs.push(dir);
  return join(dir, "nested", "exchange.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the real API that numbers its answers. */
function upstream(): FetchLike & { calls: number } {
  const fake = Object.assign(
    async (_input: string | URL | Request, _init?: RequestInit) => {
      fake.calls++;
      return new Response(JSON.stringify({ answer: fake.calls }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "request-id": "req_secret",
          "set-cookie": "x",
        },
      });
    },
    { calls: 0 },
  );
  return fake;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "x-api-key": "sk-ant-test-key", "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("cassetteFetch", () => {
  it("records method, path, body, status, and content type, and nothing else", async () => {
    const file = tempCassette();
    const fetch = cassetteFetch(file, "record", upstream());
    const response = await fetch("https://api.anthropic.com/v1/messages?beta=true", post({ q: 1 }));
    expect(await response.json()).toEqual({ answer: 1 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([
      {
        request: { method: "POST", path: "/v1/messages?beta=true", body: { q: 1 } },
        response: { status: 200, contentType: "application/json", body: '{"answer":1}' },
      },
    ]);
    expect(readFileSync(file, "utf8")).not.toMatch(/sk-ant|x-api-key|request-id|cookie/);
  });

  it("replays by method, path, and body, whatever the key order", async () => {
    const file = tempCassette();
    const record = cassetteFetch(file, "record", upstream());
    await record("https://api.anthropic.com/v1/messages", post({ a: 1, b: 2 }));
    await record("https://api.anthropic.com/v1/other", { method: "GET" });
    const offline = upstream();
    const replay = cassetteFetch(file, "replay", offline);
    expect(await (await replay("https://x.test/v1/other")).json()).toEqual({ answer: 2 });
    const reordered = await replay("https://x.test/v1/messages", post({ b: 2, a: 1 }));
    expect(await reordered.json()).toEqual({ answer: 1 });
    expect(reordered.headers.get("content-type")).toBe("application/json");
    expect(offline.calls).toBe(0);
  });

  it("replays identical requests in recorded order, each once", async () => {
    const file = tempCassette();
    const record = cassetteFetch(file, "record", upstream());
    for (let i = 0; i < 2; i++)
      await record("https://api.anthropic.com/v1/poll", { method: "GET" });
    const replay = cassetteFetch(file, "replay");
    const answers = [];
    for (let i = 0; i < 2; i++) answers.push(await (await replay("https://a.test/v1/poll")).json());
    expect(answers).toEqual([{ answer: 1 }, { answer: 2 }]);
    await expect(replay("https://a.test/v1/poll")).rejects.toThrow(CassetteMissError);
  });

  it("fails loudly on a request it has no recording for", async () => {
    const replay = cassetteFetch(tempCassette(), "replay");
    await expect(replay("https://a.test/v1/messages", post({ q: 2 }))).rejects.toThrow(
      /no unused recording for POST \/v1\/messages; re-record with pnpm cassettes:record/,
    );
  });
});

describe("cassetteMode", () => {
  it("records only when REPOWIKI_CASSETTE=record", () => {
    const saved = process.env.REPOWIKI_CASSETTE;
    try {
      process.env.REPOWIKI_CASSETTE = "record";
      expect(cassetteMode()).toBe("record");
      process.env.REPOWIKI_CASSETTE = "yes";
      expect(cassetteMode()).toBe("replay");
      delete process.env.REPOWIKI_CASSETTE;
      expect(cassetteMode()).toBe("replay");
    } finally {
      if (saved === undefined) delete process.env.REPOWIKI_CASSETTE;
      else process.env.REPOWIKI_CASSETTE = saved;
    }
  });
});
