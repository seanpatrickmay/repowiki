import {
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makeRevision,
  SHA_A,
  SHA_B,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  backlinksHtml,
  citationHtml,
  codeUrl,
  collectReferences,
  markersHtml,
} from "./references.ts";
import { fixtureExport } from "./test-fixtures.ts";

const REPO = "https://github.com/acme/demo-repo";
const signals = fixtureExport().pages.find((page) => page.featureId === "signals");
if (signals === undefined) throw new Error("fixture has no signals page");

describe("collectReferences", () => {
  it("numbers citations in reading order and reuses numbers for identical citations", () => {
    const refs = collectReferences(signals);
    expect(refs.notes.map((note) => [note.n, note.backlinks])).toEqual([
      [1, ["cite-ref-1-0", "cite-ref-1-1", "cite-ref-1-2"]],
      [2, ["cite-ref-2-0", "cite-ref-2-1"]],
      [3, ["cite-ref-3-0"]],
      [4, ["cite-ref-4-0"]],
      [5, ["cite-ref-5-0"]],
    ]);
    expect(refs.markers.get("s-o2")).toEqual([
      { n: 1, id: "cite-ref-1-1" },
      { n: 2, id: "cite-ref-2-0" },
    ]);
    expect(refs.markers.get("s-lead-1")).toEqual([]);
  });

  it("treats the same lines at another sha as a different source", () => {
    const claim = bodyClaim({ citations: [codeCitation(), codeCitation({ sha: SHA_B })] });
    const revision = makeRevision({
      sections: [
        { key: "lead", claims: [leadClaim()] },
        { key: "overview", claims: [claim] },
      ],
    });
    expect(collectReferences(revision).notes.map((note) => note.n)).toEqual([1, 2]);
  });
});

describe("markersHtml and backlinksHtml", () => {
  it("renders footnote markers that link to their note", () => {
    expect(markersHtml([{ n: 2, id: "cite-ref-2-0" }])).toBe(
      '<sup class="reference" id="cite-ref-2-0"><a href="#cite-note-2">[2]</a></sup>',
    );
  });

  it("renders ^ for one use and lettered back-links for several", () => {
    const one = { n: 1, citation: commitCitation(), backlinks: ["cite-ref-1-0"] };
    expect(backlinksHtml(one)).toBe(
      '<a class="ref-back" href="#cite-ref-1-0" aria-label="Back to the citing claim">^</a>',
    );
    const two = { ...one, backlinks: ["cite-ref-1-0", "cite-ref-1-1"] };
    expect(backlinksHtml(two)).toBe(
      '^ <a class="ref-back" href="#cite-ref-1-0" aria-label="Back to citing claim 1">a</a> <a class="ref-back" href="#cite-ref-1-1" aria-label="Back to citing claim 2">b</a>',
    );
  });
});

describe("citationHtml", () => {
  it("renders a code citation as path:Lstart-end@sha with a permalink", () => {
    expect(citationHtml(codeCitation(), REPO)).toBe(
      `<a class="external" href="${REPO}/blob/${SHA_A}/src/signals/ingest.py#L10-L24"><code>src/signals/ingest.py:L10-24@aaaaaaa</code></a> (<code>ingest_chunk</code>)`,
    );
  });

  it("percent-encodes each path segment and uses one line number for one-line ranges", () => {
    const odd = codeCitation({ path: "src/a b/c#1%.py", startLine: 7, endLine: 7, symbol: null });
    expect(codeUrl(REPO, odd)).toBe(`${REPO}/blob/${SHA_A}/src/a%20b/c%231%25.py#L7`);
    expect(citationHtml(odd, null)).toBe("<code>src/a b/c#1%.py:L7@aaaaaaa</code>");
  });

  it("renders a commit citation with its subject and PR", () => {
    expect(citationHtml(commitCitation({ subject: 'fix: "quote" <b>' }), REPO)).toBe(
      `Commit <a class="external" href="${REPO}/commit/${SHA_A}"><code>aaaaaaa</code></a>: &quot;fix: &quot;quote&quot; &lt;b&gt;&quot; (<a class="external" href="${REPO}/pull/45">PR #45</a>)`,
    );
    expect(citationHtml(commitCitation({ pr: null }), null)).toBe(
      "Commit <code>aaaaaaa</code>: &quot;feat: add signal ingestion&quot;",
    );
  });
});
