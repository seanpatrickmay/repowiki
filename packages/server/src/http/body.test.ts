import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BODY_LIMIT, HttpError, readBody, readForm, readJson } from "./body.ts";

/** A request body arriving in `chunks`, with `headers`. */
function request(chunks: string[], headers: Record<string, string>): IncomingMessage {
  return Object.assign(Readable.from(chunks.map((c) => Buffer.from(c))), {
    headers,
  }) as unknown as IncomingMessage;
}

const asJson = (body: string, type = "application/json") =>
  request([body], { "content-type": type });

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof HttpError ? error.status : undefined;
}

describe("readJson (spec 2 S2)", () => {
  const schema = z.strictObject({ n: z.int() });

  it("reads JSON that its schema accepts, with a charset parameter", async () => {
    expect(await readJson(asJson('{"n":3}', "application/json; charset=utf-8"), schema)).toEqual({
      n: 3,
    });
  });

  it("refuses a wrong type, malformed JSON, a schema miss and an unknown field", async () => {
    expect(await statusOf(readJson(asJson('{"n":3}', "text/plain"), schema))).toBe(415);
    expect(await statusOf(readJson(asJson("{"), schema))).toBe(400);
    expect(await statusOf(readJson(asJson('{"n":"x"}'), schema))).toBe(400);
    const unknown = await readJson(asJson('{"n":3,"admin":true}'), schema).catch((e) => e);
    expect(unknown).toBeInstanceOf(HttpError);
    expect((unknown as HttpError).status).toBe(400);
    expect((unknown as HttpError).message).toContain("admin");
  });
});

describe("readBody (spec 2 S2)", () => {
  it("refuses a declared length over the limit before reading", async () => {
    const declared = request(["{}"], { "content-length": String(BODY_LIMIT + 1) });
    expect(await statusOf(readBody(declared, BODY_LIMIT))).toBe(413);
  });

  it("refuses a body that streams past the limit whatever it declared", async () => {
    const half = "x".repeat(BODY_LIMIT / 2 + 1);
    const lying = request([half, half], { "content-length": "2" });
    expect(await statusOf(readBody(lying, BODY_LIMIT))).toBe(413);
    expect((await readBody(request([half], {}), BODY_LIMIT)).length).toBe(half.length);
  });
});

describe("readForm (spec 2 S2)", () => {
  it("reads a urlencoded form and refuses another type", async () => {
    const form = request(["a=1&b=two"], { "content-type": "application/x-www-form-urlencoded" });
    expect(Object.fromEntries(await readForm(form))).toEqual({ a: "1", b: "two" });
    expect(await statusOf(readForm(request(["a=1"], { "content-type": "text/plain" })))).toBe(415);
  });
});
