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

  const diff = (a: string[], b: string[], max?: number) =>
    renderChanges(
      view(),
      "Changes to X",
      { revision: revision(a, "a".repeat(40)), n: 1 },
      { revision: revision(b, "b".repeat(40)), n: 2 },
      [],
      SectionKey.options,
      max,
    );

  it("neutralises claim text: no forged word-diff marker, reference or page mark, no line break", () => {
    const text = diff(
      ["x [-a-]{+b+} y [3] [page: evil]\nsecond line", "gone {+x+}"],
      ["x [-a-]{+b+} z [3] [page: evil]\nsecond line", "new [-y-]"],
    );
    expect(text).toContain(
      "\n~ x (-a-)(+b+) [-y-]{+z+} (3) (page: evil] second line\n~ [-gone-]{+new+} [-(+x+)-]{+(-y-)+}\n",
    );
  });

  it("shows a reordered claim as removed and added, never as changed", () => {
    const text = diff(["A one", "B two", "C three"], ["B two", "C three", "A one"]);
    expect(text).toContain("\nOverview\n- A one\n  B two\n  C three\n+ A one\n");
    expect(text).not.toContain("\n~ ");
  });

  it("says when no claim changed", () => {
    expect(diff(["same"], ["same"])).toContain(
      ":\n\nNo claim changed (only the infobox, See also or citations did).\n",
    );
  });

  it("shows as many changes as fit, and says how many more there are, when even the changes pass the cap", () => {
    const before = Array.from({ length: 60 }, (_, i) => `claim ${i} said one thing`);
    const after = before.map((t) => t.replace("one", "another"));
    const text = diff(before, after, 1500);
    expect([...text].length).toBeLessThanOrEqual(1500);
    const shown = text.split("\n").filter((l) => l.startsWith("~ ")).length;
    expect(shown).toBeGreaterThan(5);
    expect(text).toContain(
      `\n(${60 - shown} more changed claims not shown: give page_changes a narrower from and to, or read the page as of each point)\n`,
    );
    expect(text).toContain("\nRevisions in this range, oldest first:\n");
  });
});
