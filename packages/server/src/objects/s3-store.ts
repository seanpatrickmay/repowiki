import { createHash } from "node:crypto";
import { encodeRfc3986, signV4 } from "./sigv4.ts";
import { assertKey, type ObjectStore } from "./store.ts";

export interface S3Options {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch: typeof fetch;
  now: () => Date;
  region?: string;
}

const amzDate = (at: Date) =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const unescapeXml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
const MAX_LIST_PAGES = 1000;

/** R2 (or any S3 API) with path-style URLs, signed by hand (spec 2 S12). */
export function s3ObjectStore(options: S3Options): ObjectStore {
  const region = options.region ?? "auto";
  const bucketUrl = `${options.endpoint}/${encodeRfc3986(options.bucket)}`;
  const objectUrl = (key: string) => {
    assertKey(key);
    return new URL(`${bucketUrl}/${key.split("/").map(encodeRfc3986).join("/")}`);
  };

  async function send(
    method: string,
    url: URL,
    body?: Uint8Array<ArrayBuffer>,
    contentType?: string,
  ) {
    const date = amzDate(options.now());
    const headers: Record<string, string> = {
      "x-amz-content-sha256": createHash("sha256")
        .update(body ?? new Uint8Array())
        .digest("hex"),
      "x-amz-date": date,
      ...(body === undefined
        ? {}
        : {
            "content-length": String(body.length),
            "content-type": contentType ?? "application/octet-stream",
          }),
    };
    const authorization = signV4({
      method,
      url,
      headers,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region,
      service: "s3",
      amzDate: date,
    });
    return options.fetch(url, {
      method,
      headers: { ...headers, authorization },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(30_000),
    });
  }

  const fail = (verb: string, response: Response) =>
    new Error(`object store ${verb} failed: ${response.status}`);

  return {
    async put(key, body, contentType) {
      const url = objectUrl(key);
      const bytes =
        typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
      const response = await send("PUT", url, bytes, contentType);
      if (!response.ok) throw fail("PUT", response);
    },
    async get(key) {
      const response = await send("GET", objectUrl(key));
      if (response.status === 404) return null;
      if (!response.ok) throw fail("GET", response);
      return {
        body: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
      };
    },
    async head(key) {
      const response = await send("HEAD", objectUrl(key));
      if (response.status === 404) return null;
      if (!response.ok) throw fail("HEAD", response);
      return {
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        size: Number(response.headers.get("content-length") ?? 0),
      };
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        // Built by hand: URLSearchParams writes a space as "+", which SigV4 would sign differently.
        const query = `list-type=2&prefix=${encodeRfc3986(prefix)}${token === null ? "" : `&continuation-token=${encodeRfc3986(token)}`}`;
        const response = await send("GET", new URL(`${bucketUrl}?${query}`));
        if (!response.ok) throw fail("LIST", response);
        const xml = await response.text();
        for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
          keys.push(unescapeXml(match[1] ?? ""));
        }
        const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && next ? unescapeXml(next) : null;
        if (token === null) break;
      }
      return keys.sort();
    },
    async delete(keys) {
      const urls = keys.map(objectUrl);
      for (const url of urls) {
        const response = await send("DELETE", url);
        if (!response.ok && response.status !== 404) throw fail("DELETE", response);
      }
    },
  };
}
