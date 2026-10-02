import { describe, expect, it } from "vitest";
import { contentHash } from "./content-hash.ts";
import { codeCitation, INGEST_PY, sourceLines } from "./test-fixtures.ts";

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

describe("the codeCitation fixture (issue #53)", () => {
  it("hashes exactly the 15 lines it cites, lines 10-24 of INGEST_PY", () => {
    const cited = INGEST_PY.split("\n").slice(9, 24);
    expect(cited).toHaveLength(15);
    expect(cited[0]).toBe("def ingest_chunk(chunk):");
    expect(cited.at(-1)).toBe("    return signals");
    expect(codeCitation().contentHash).toBe(contentHash(cited.join("\n")));
    expect(sourceLines(INGEST_PY, 10, 24)).toBe(cited.join("\n"));
  });

  it("is 31 lines long, ending in a newline", () => {
    expect(INGEST_PY.endsWith("\n")).toBe(true);
    expect(INGEST_PY.split("\n")).toHaveLength(32);
  });
});
