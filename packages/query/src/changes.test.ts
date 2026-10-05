import { SectionKey } from "@repowiki/core";
import { bodyClaim, makeRevision } from "@repowiki/core/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderChanges, wordDiffText } from "./changes.ts";
import { type SampleWiki, sampleWiki } from "./test-wiki.ts";
import { WikiView } from "./wiki-view.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

const revision = (texts: string[], sha: string) =>
  makeRevision({
    sha,
    sections: [
      { key: "lead", claims: makeRevision().sections[0]?.claims ?? [] },
      { key: "overview", claims: texts.map((text, i) => bodyClaim({ id: `c-${i}`, text })) },
    ],
  });

describe("wordDiffText", () => {
  it("marks removed and added words in place", () => {
    expect(wordDiffText("a b c", "a x c")).toBe("a [-b-]{+x+} c");
    expect(wordDiffText("same", "same")).toBe("same");
  });
});

describe("renderChanges", () => {
  const view = () => new WikiView(sample.wiki);
  const from = revision(
    ["keep [[deliverables]]", "old one", ...Array(40).fill("same")],
    "a".repeat(40),
  );
  const to = revision(
    ["keep [[deliverables]]", "new one", ...Array(40).fill("same"), "added"],
    "b".repeat(40),
  );
  const range = [from, to];

  it("shows unchanged claims as context, links as their page ids", () => {
    const text = renderChanges(
      view(),
      "Changes to X",
      { revision: from, n: 1 },
      { revision: to, n: 2 },
      range,
      SectionKey.options,
    );
    expect(text).toContain(
      "\nOverview\n  keep Deliverables [page: deliverables]\n~ [-old-]{+new+} one\n  same\n",
    );
    expect(text).toContain(
      "\n+ added\n\nRevisions in this range, oldest first:\n- 2026-02-03 commit aaaaaaa (build)\n- 2026-02-03 commit bbbbbbb (build)\n",
    );
  });

  it("counts unchanged claims instead of listing them when the whole diff passes the cap", () => {
    const text = renderChanges(
      view(),
      "Changes to X",
      { revision: from, n: 1 },
      { revision: to, n: 2 },
      range,
      SectionKey.options,
      400,
    );
    expect(text).toContain(
      "\nOverview\n  (1 unchanged claim)\n~ [-old-]{+new+} one\n  (40 unchanged claims)\n+ added\n",
    );
  });

  it("says so when both points have the same revision", () => {
    expect(
      renderChanges(
        view(),
        "Changes to X",
        { revision: to, n: 2 },
        { revision: to, n: 2 },
        [to],
        SectionKey.options,
      ),
    ).toBe(
      "Changes to X from revision 2 (commit bbbbbbb, 2026-02-03) to revision 2 (commit bbbbbbb, 2026-02-03):\nThe same revision is current at both points: nothing changed between them.\n",
    );
  });
});
