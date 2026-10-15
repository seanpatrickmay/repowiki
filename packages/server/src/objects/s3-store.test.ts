import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { objectStoreFor } from "./open.ts";
import { ObjectListTruncated, s3ObjectStore } from "./s3-store.ts";
import { signV4 } from "./sigv4.ts";

const HTML = "text/html; charset=utf-8";
let calls: { method: string; url: string; headers: Headers; body: string }[];
let objects: Map<string, { body: string; type: string }>;

/** A bucket named "bucket" that speaks just enough of the S3 API. */
const fake: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const body = init?.body === undefined ? "" : Buffer.from(init.body as Uint8Array).toString();
  calls.push({ method, url: url.href, headers, body });
  // Verify as S3 would: the signature recomputed from the request as received.
  const signed = Object.fromEntries([...headers].filter(([name]) => name !== "authorization"));
  const expected = signV4({
    method,
    url,
    headers: signed,
    accessKeyId: "id",
    secretAccessKey: "secret",
    region: "auto",
    service: "s3",
    amzDate: headers.get("x-amz-date") ?? "",
  });
  const digest = createHash("sha256").update(body).digest("hex");
  if (headers.get("authorization") !== expected || headers.get("x-amz-content-sha256") !== digest) {
    return new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", { status: 403 });
  }
  const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ""));
  if (method === "PUT") {
    objects.set(key, { body, type: headers.get("content-type") ?? "" });
    return new Response(null, { status: 200 });
  }
  if (method === "DELETE") {
    objects.delete(key);
    return new Response(null, { status: 204 });
  }
  if (url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const token = url.searchParams.get("continuation-token");
    const page = token === null ? keys.slice(0, 1) : keys.slice(1);
    const more = token === null && keys.length > 1;
    const contents = page.map(
      (k) => `<Contents><Key>${k.replaceAll("&", "&amp;")}</Key></Contents>`,
    );
    return new Response(
      `<?xml version="1.0"?><ListBucketResult>${contents.join("")}<IsTruncated>${more}</IsTruncated>${more ? "<NextContinuationToken>t/1+=</NextContinuationToken>" : ""}</ListBucketResult>`,
    );
  }
  const found = objects.get(key);
  if (found === undefined)
    return new Response(method === "HEAD" ? null : "<Error/>", { status: 404 });
  const reply = { "content-type": found.type, "content-length": String(found.body.length) };
  return new Response(method === "HEAD" ? null : found.body, { headers: reply });
};

const s3 = s3ObjectStore({
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "bucket",
  accessKeyId: "id",
  secretAccessKey: "secret",
  fetch: fake,
  now: () => new Date("2026-10-14T12:00:00Z"),
});

beforeEach(() => {
  calls = [];
  objects = new Map();
});

describe("the S3 store (spec 2 S12)", () => {
  it("signs every request and round-trips objects", async () => {
    await s3.put("sites/p/v1/a b&c.html", "hi", HTML);
    expect(calls[0]?.url).toBe(
      "https://acct.r2.cloudflarestorage.com/bucket/sites/p/v1/a%20b%26c.html",
    );
    expect(calls[0]?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=id\/20261014\/auto\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(calls[0]?.headers.get("x-amz-date")).toBe("20261014T120000Z");
    expect(calls[0]?.headers.get("x-amz-content-sha256")).toBe(
      "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    );
    const got = await s3.get("sites/p/v1/a b&c.html");
    expect(Buffer.from(got?.body ?? []).toString()).toBe("hi");
    expect(got?.contentType).toBe(HTML);
    expect(await s3.head("sites/p/v1/a b&c.html")).toEqual({ contentType: HTML, size: 2 });
    expect(await s3.get("sites/p/v1/none.html")).toBeNull();
    expect(await s3.head("sites/p/v1/none.html")).toBeNull();
    expect(calls.every((c) => c.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256"))).toBe(
      true,
    );
  });

  it("lists across continuation pages and deletes", async () => {
    await s3.put("sites/q/1.html", "1", HTML);
    await s3.put("sites/q/2.html", "2", HTML);
    await s3.put("sites/r/3.html", "3", HTML);
    expect(await s3.list("sites/q/")).toEqual(["sites/q/1.html", "sites/q/2.html"]);
    const second = calls.filter((c) => c.url.includes("continuation-token")).at(-1);
    expect(second?.url).toContain("continuation-token=t%2F1%2B%3D");
    expect(second?.url).toContain("prefix=sites%2Fq%2F");
    await s3.delete(["sites/q/1.html"]);
    expect(await s3.list("sites/q/")).toEqual(["sites/q/2.html"]);
  });

  it("lists a prefix holding an ampersand", async () => {
    await s3.put("sites/a&b/1.html", "1", HTML);
    await s3.put("sites/a&b/2.html", "2", HTML);
    await s3.put("sites/a/3.html", "3", HTML);
    expect(await s3.list("sites/a&b/")).toEqual(["sites/a&b/1.html", "sites/a&b/2.html"]);
  });

  it("refuses to return a listing cut short by the page cap", async () => {
    const endless = s3ObjectStore({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
      fetch: async () =>
        new Response(
          "<ListBucketResult><Contents><Key>k</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t</NextContinuationToken></ListBucketResult>",
        ),
      now: () => new Date("2026-10-14T12:00:00Z"),
    });
    await expect(endless.list("k")).rejects.toBeInstanceOf(ObjectListTruncated);
  });

  it("refuses a bad key before any request", async () => {
    for (const bad of ["../a", "/a", "a\\b", "a/../b"]) {
      await expect(s3.put(bad, "x", HTML)).rejects.toThrow("invalid object key");
      await expect(s3.get(bad)).rejects.toThrow("invalid object key");
      await expect(s3.head(bad)).rejects.toThrow("invalid object key");
      await expect(s3.delete([bad])).rejects.toThrow("invalid object key");
    }
    expect(calls).toEqual([]);
  });

  it("raises on an unexpected status without echoing the request", async () => {
    const down = s3ObjectStore({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
      fetch: async () => new Response("<Error/>", { status: 500 }),
      now: () => new Date("2026-10-14T12:00:00Z"),
    });
    await expect(down.get("a.html")).rejects.toThrow("object store GET failed: 500");
    await expect(down.put("a.html", "x", HTML)).rejects.toThrow("object store PUT failed: 500");
    await expect(down.list("a")).rejects.toThrow("object store LIST failed: 500");
  });
});

describe("objectStoreFor (spec 2 S12, S17)", () => {
  it("opens R2 through the given fetch in production's configuration", async () => {
    const store = objectStoreFor(
      {
        kind: "s3",
        endpoint: "https://acct.r2.cloudflarestorage.com",
        bucket: "bucket",
        accessKeyId: "id",
        secretAccessKey: "secret",
      },
      fake,
    );
    await store.put("a.html", "x", HTML);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PUT https://acct.r2.cloudflarestorage.com/bucket/a.html",
    ]);
  });
});
