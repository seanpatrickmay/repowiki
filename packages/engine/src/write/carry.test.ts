import type { Feature, Revision } from "@repowiki/core";
import { bodyClaim, makeFeature, makeManifest, makeRevision } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import type { CommitInfo } from "../index/index.ts";
import { ancestry, carriedHistory } from "./carry.ts";

const sha = (digit: string) => digit.repeat(40);
/** A page of `featureId` at `at` whose History claims each cite one commit. */
const page = (featureId: string, at: string, ...history: [string, string][]): Revision =>
  makeRevision({
    id: `${featureId}-${at.slice(0, 4)}`,
    featureId,
    sha: at,
    sections: [
      {
        key: "history",
        claims: history.map(([text, commit], i) =>
          bodyClaim({
            id: `h${i + 1}`,
            text,
            kind: "history",
            citations: [{ kind: "commit", sha: commit, subject: "a commit", pr: null }],
          }),
        ),
      },
    ],
  });
/** `id`, merged into `into` at `at`. */
const merged = (id: string, into: string, at: string): Feature =>
  makeFeature({
    id,
    title: id,
    aliases: [],
    status: { kind: "redirect", to: into },
    lineage: [
      { kind: "create", sha: sha("0") },
      { kind: "merge", sha: at, into },
    ],
  });
/** A first-parent history, newest first, of the given commits, oldest first. */
const linear = (...shas: string[]): CommitInfo[] =>
  shas
    .map((s, i) => ({
      sha: s,
      parents: i === 0 ? [] : [shas[i - 1] as string],
      date: "2026-10-01T00:00:00Z",
      subject: "a commit",
      files: [],
      pr: null,
    }))
    .reverse();
const texts = (
  manifest: ReturnType<typeof makeManifest>,
  featureId: string,
  pages: Map<string, Revision | null>,
  history: CommitInfo[],
) =>
  carriedHistory(
    manifest,
    featureId,
    pages.get(featureId) ?? null,
    (id) => pages.get(id) ?? null,
    ancestry(history),
  ).map((c) => c.text);

describe("carriedHistory", () => {
  it("visits each feature once when hostile lineage makes the merges a cycle", () => {
    // Not a valid manifest (a redirect cycle), so it is built without the schema.
    const manifest = makeManifest({
      features: [merged("a", "c", sha("1")), merged("c", "a", sha("1"))],
    });
    const pages = new Map([
      ["a", page("a", sha("0"), ["A began.", sha("0")])],
      ["c", page("c", sha("0"), ["C began.", sha("0")])],
    ]);
    expect(texts(manifest, "a", pages, linear(sha("0"), sha("1")))).toEqual([
      "A began.",
      "C began.",
    ]);
  });

  it("keeps a page's History through a merged page that never carried it", () => {
    // At 1, a merges into b, whose whole write fails; at 2, c gets an update; at 3, b merges
    // into c. c's page, at 2, contains a's merge but never carried it: only b's page could have.
    const [s0, s1, s2, s3] = [sha("0"), sha("1"), sha("2"), sha("3")];
    const manifest = makeManifest({
      features: [makeFeature({ id: "c" }), merged("b", "c", s3), merged("a", "b", s1)],
    });
    const history = linear(s0, s1, s2, s3);
    const pages = new Map<string, Revision | null>([
      ["a", page("a", s0, ["A began.", s0])],
      ["b", page("b", s0, ["B began.", s0])],
      ["c", page("c", s2, ["C began.", s0])],
    ]);
    expect(texts(manifest, "c", pages, history)).toEqual(["C began.", "B began.", "A began."]);
    pages.set("b", null);
    expect(texts(manifest, "c", pages, history)).toEqual(["C began.", "A began."]);

    // c's next whole write, at 3, holds them all: nothing is carried twice.
    pages.set("b", page("b", s0, ["B began.", s0]));
    pages.set("c", page("c", s3, ["C began.", s0], ["B began.", s0], ["A began.", s0]));
    expect(texts(manifest, "c", pages, history)).toEqual(["C began.", "B began.", "A began."]);
  });

  it("takes a merge the history does not reach as contained by a page citing its commit", () => {
    // A shallow history: neither the merge at 9 nor c's page is in it.
    const [sb, sc, sm] = [sha("b"), sha("c"), sha("9")];
    const manifest = makeManifest({ features: [makeFeature({ id: "c" }), merged("b", "c", sm)] });
    const pages = new Map<string, Revision | null>([
      ["b", page("b", sb, ["B began.", sb])],
      ["c", page("c", sm, ["C began.", sc], ["B began.", sb], ["B was merged in.", sm])],
    ]);
    expect(texts(manifest, "c", pages, linear(sb))).toEqual([
      "C began.",
      "B began.",
      "B was merged in.",
    ]);
    // With no claim citing the merge, the page cannot say: b's History is carried again rather
    // than risk losing it.
    pages.set("c", page("c", sm, ["C began.", sc], ["B began.", sb]));
    expect(texts(manifest, "c", pages, linear(sb))).toEqual(["C began.", "B began.", "B began."]);
  });
});
