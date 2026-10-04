import type { Feature, Revision } from "@repowiki/core";
import {
  bodyClaim,
  makeFeature,
  makeManifest,
  makeRevision,
  SHA_A,
  SHA_B,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { carriedHistory } from "./carry.ts";

/** A page of `featureId` whose one History claim, `text`, cites SHA_A. */
const page = (featureId: string, text: string): Revision =>
  makeRevision({
    id: `${featureId}-1`,
    featureId,
    sections: [
      {
        key: "history",
        claims: [
          bodyClaim({
            id: "h1",
            text,
            kind: "history",
            citations: [{ kind: "commit", sha: SHA_A, subject: "first", pr: null }],
          }),
        ],
      },
    ],
  });
const merged = (id: string, into: string): Feature =>
  makeFeature({
    id,
    title: id,
    aliases: [],
    status: { kind: "redirect", to: into },
    lineage: [
      { kind: "create", sha: SHA_A },
      { kind: "merge", sha: SHA_B, into },
    ],
  });

describe("carriedHistory", () => {
  it("visits each feature once when hostile lineage makes the merges a cycle", () => {
    // Not a valid manifest (a redirect cycle), so it is built without the schema.
    const manifest = makeManifest({ features: [merged("a", "c"), merged("c", "a")] });
    const pages = new Map([
      ["a", page("a", "A began.")],
      ["c", page("c", "C began.")],
    ]);
    const claims = carriedHistory(
      manifest,
      "a",
      pages.get("a") ?? null,
      (id) => pages.get(id) ?? null,
      [],
    );
    expect(claims.map((c) => c.text)).toEqual(["A began.", "C began."]);
  });
});
