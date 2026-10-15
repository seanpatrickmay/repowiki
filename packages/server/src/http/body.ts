import type { IncomingMessage } from "node:http";
import type { z } from "zod";

export const BODY_LIMIT = 65_536;

/** An error a handler means the client to see, with its status and message. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The request body, refused with 413 past `limit` whether declared or streamed. */
export async function readBody(raw: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(raw.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    raw.resume();
    throw new HttpError(413, "Request body too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of raw) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      raw.resume();
      throw new HttpError(413, "Request body too large.");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function contentType(raw: IncomingMessage): string {
  return (raw.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** A JSON body its schema accepts; 415, 400 or 413 otherwise. */
export async function readJson<T>(
  raw: IncomingMessage,
  schema: z.ZodType<T>,
  limit = BODY_LIMIT,
): Promise<T> {
  if (contentType(raw) !== "application/json") {
    throw new HttpError(415, "Expected application/json.");
  }
  const text = (await readBody(raw, limit)).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Malformed JSON.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "body";
    const keys = issue && "keys" in issue ? ` (${(issue.keys as string[]).join(", ")})` : "";
    throw new HttpError(400, `${where}: ${issue?.message ?? "invalid"}${keys}`);
  }
  return parsed.data;
}

/** A urlencoded form body; 415 or 413 otherwise. */
export async function readForm(raw: IncomingMessage, limit = BODY_LIMIT): Promise<URLSearchParams> {
  if (contentType(raw) !== "application/x-www-form-urlencoded") {
    throw new HttpError(415, "Expected a form.");
  }
  return new URLSearchParams((await readBody(raw, limit)).toString("utf8"));
}
