import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalQuery, signV4 } from "./sigv4.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * AWS's published examples for S3 (Signature Version 4, "Examples: Signature Calculations in AWS
 * Signature Version 4", single-chunk payload): examplebucket in us-east-1 at 20130524T000000Z.
 */
const aws = (method: string, path: string, headers: Record<string, string>) =>
  signV4({
    method,
    url: new URL(`https://examplebucket.s3.amazonaws.com${path}`),
    headers: { "x-amz-date": "20130524T000000Z", ...headers },
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    amzDate: "20130524T000000Z",
  });
const credential =
  "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request";

describe("SigV4 against AWS's published S3 examples (spec 2 S12)", () => {
  it("signs GET Object with a Range header", () => {
    expect(aws("GET", "/test.txt", { range: "bytes=0-9", "x-amz-content-sha256": sha("") })).toBe(
      `${credential}, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`,
    );
  });

  it("signs PUT Object, encoding the key's $", () => {
    expect(
      aws("PUT", "/test$file.text", {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
        "x-amz-content-sha256": sha("Welcome to Amazon S3."),
      }),
    ).toBe(
      `${credential}, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd`,
    );
  });

  it("signs GET Bucket Lifecycle, a query key with no value", () => {
    expect(aws("GET", "/?lifecycle", { "x-amz-content-sha256": sha("") })).toBe(
      `${credential}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543`,
    );
  });

  it("signs GET Bucket (List Objects), sorting the query", () => {
    expect(aws("GET", "/?prefix=J&max-keys=2", { "x-amz-content-sha256": sha("") })).toBe(
      `${credential}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7`,
    );
  });
});

/** R2-shaped requests; expected values from the independent `aws4` library. */
describe("SigV4 for R2 requests (spec 2 S12)", () => {
  const r2 = (method: string, path: string) =>
    signV4({
      method,
      url: new URL(`https://acct.r2.cloudflarestorage.com${path}`),
      headers: { "x-amz-content-sha256": sha(""), "x-amz-date": "20261014T120000Z" },
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "auto",
      service: "s3",
      amzDate: "20261014T120000Z",
    }).split("Signature=")[1];

  it("signs a list with an encoded prefix and a delete with an encoded key", () => {
    expect(r2("GET", "/repowiki?list-type=2&prefix=sites%2Fa%2F")).toBe(
      "607662d1f3c643454dd638cad9e5d49483b29a98d3fd9277040cde3d8361a0b3",
    );
    expect(r2("DELETE", "/repowiki/sites/a/v1/a%20b.html")).toBe(
      "fbde1558d9653320f70506eab46eb16f5fe7bae0f37a95c0bafc7de80fb00fd1",
    );
  });
});

describe("the canonical query (spec 2 S12)", () => {
  it("sorts by key and then value, not by the joined pair", () => {
    expect(canonicalQuery("?a-b=1&a=2")).toBe("a=2&a-b=1");
    expect(canonicalQuery("?b=2&b=1&a")).toBe("a=&b=1&b=2");
    expect(canonicalQuery("?prefix=a%20b%2F&list-type=2")).toBe("list-type=2&prefix=a%20b%2F");
    expect(canonicalQuery("")).toBe("");
  });
});
