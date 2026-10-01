import { describe, expect, it } from "vitest";
import { contentHash } from "./content-hash.ts";

describe("contentHash", () => {
  it("is the sha256 of the lines", () => {
    expect(contentHash("alpha\nbeta")).toBe(
      "bbfb79e82216bd2db1ad2c507d44ddf80aeb12f64f9562056afe93aad43154d9",
    );
  });

  it("ignores CRLF line endings and one trailing newline", () => {
    expect(contentHash("alpha\r\nbeta\r\n")).toBe(contentHash("alpha\nbeta"));
  });

  it("changes when content changes", () => {
    expect(contentHash("alpha\nbeta\ngamma")).toBe(
      "f3220283d05d1ff2ae350cfe9e0e367cb5aef46e10efb203c8a53c678e2218c8",
    );
  });
});
