import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accuracySheet, tallySheet } from "./accuracy.ts";
import { type SampleWiki, sampleWiki } from "./test-wiki.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

describe("accuracySheet", () => {
  it("lists every claim of the named pages with its section and references", () => {
    const sha7 = sample.sha.slice(0, 7);
    expect(accuracySheet(sample.wiki, ["deliverables"]).split("\n").slice(-6)).toEqual([
      "## Deliverables (deliverables)",
      "",
      "- [ ] `deliverables/d-lead` (Lead): **Deliverables** are the records sample builds from signals.",
      `- [ ] \`deliverables/d-1\` (Overview): \`create_deliverable\` returns a deliverable: a title and the list of signals it is built from. (src/deliverables/crud.py:4-6@${sha7})`,
      `- [ ] \`deliverables/d-h\` (History): Deliverables were added in pull request #7. (commit ${sha7})`,
      "",
    ]);
  });

  it("lists every active page when no page is named", () => {
    const sheet = accuracySheet(sample.wiki, []);
    expect(sheet).toContain("## Signal ingestion (signals)");
    expect(sheet).toContain("## Deliverables (deliverables)");
    expect(sheet.match(/^- \[ \] /gm)).toHaveLength(8);
  });
});

describe("tallySheet", () => {
  const sheet = (marks: string[]) =>
    marks.map((m, i) => `- [${m}] \`p/c${i}\` (Overview): claim ${i}`).join("\n");

  it("passes with at most one false claim per 50 reviewed", () => {
    const fifty = sheet([...Array(49).fill("x"), "!", " ", " "]);
    expect(tallySheet(fifty)).toEqual({
      reviewed: 50,
      false: 1,
      unmarked: 2,
      falseClaims: ["p/c49"],
      pass: true,
    });
    expect(tallySheet(sheet([...Array(48).fill("x"), "!"])).pass).toBe(false);
    expect(tallySheet(sheet([" ", " "])).pass).toBe(false);
  });

  it("refuses a mark it does not know, and ignores other lines", () => {
    expect(() => tallySheet(sheet(["x", "?"]))).toThrow(
      "line 2: mark a claim [x], [!] or [ ], not [?]",
    );
    expect(tallySheet("# heading\n- [x] not a claim line\n").reviewed).toBe(0);
  });
});
