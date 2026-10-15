import { createHash, createHmac } from "node:crypto";

export interface SignInput {
  method: string;
  /** The URL exactly as it will be sent; its path and query must already be RFC 3986-encoded. */
  url: URL;
  /** Every header to sign except host, which comes from `url`; `x-amz-date` among them. */
  headers: Readonly<Record<string, string>>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  amzDate: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const hmac = (key: Buffer | string, text: string) =>
  createHmac("sha256", key).update(text).digest();

/** RFC 3986 encoding of one component, as SigV4 wants it. */
export function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const reencode = (component: string) => encodeRfc3986(decodeURIComponent(component));

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A URL's query as SigV4 signs it: each part re-encoded, pairs sorted by key, then value. */
export function canonicalQuery(search: string): string {
  return search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const at = pair.indexOf("=");
      return at === -1
        ? ([reencode(pair), ""] as const)
        : ([reencode(pair.slice(0, at)), reencode(pair.slice(at + 1))] as const);
    })
    .sort(([a, x], [b, y]) => (a === b ? compare(x, y) : compare(a, b)))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** The Authorization header for an S3 request (AWS Signature Version 4, signed payload). */
export function signV4(input: SignInput): string {
  const path = input.url.pathname.split("/").map(reencode).join("/");
  const query = canonicalQuery(input.url.search);
  const headers = new Map<string, string>([["host", input.url.host]]);
  for (const [name, value] of Object.entries(input.headers)) {
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }
  const names = [...headers.keys()].sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers.get(n)}\n`).join("");
  const signedHeaders = names.join(";");
  const payload = headers.get("x-amz-content-sha256") ?? sha256("");
  const canonical = [input.method, path, query, canonicalHeaders, signedHeaders, payload].join(
    "\n",
  );
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256(canonical)].join("\n");
  const dayKey = hmac(`AWS4${input.secretAccessKey}`, day);
  const key = hmac(hmac(hmac(dayKey, input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
