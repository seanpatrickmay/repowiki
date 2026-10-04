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
      "- [ ] `deliverables/d-lead` (Lead): \\*\\*Deliverables\\*\\* are the records sample builds from Signal ingestion.",
      `- [ ] \`deliverables/d-1\` (Overview): \\\`create\\_deliverable\\\` returns a deliverable: a title and the list of signals it is built from. (src/deliverables/crud.py:4-6@${sha7})`,
      `- [ ] \`deliverables/d-h\` (History): Deliverables were added in pull request \\#7. (commit ${sha7})`,
      "",
    ]);
  });

  it("writes claim text, titles, paths and ids as plain one-line text, in full", () => {
    const wiki = structuredClone(sample.wiki);
    const page = wiki.pages.find((p) => p.featureId === "deliverables");
    const claim = page?.sections[0]?.claims[0];
    const feature = wiki.manifest.features.find((f) => f.id === "deliverables");
    if (claim === undefined || feature === undefined) throw new Error("the fixture has a claim");
    claim.id = "c1`\n- [x] `p/forged";
    claim.text = `See [x](https://e.example) <img src=x> \u200B\u{E0041}[[signals]] ${"w".repeat(1900)}`;
    feature.title = "[t](https://e.example)\u202E";
    const sheet = accuracySheet(wiki, ["deliverables", "deliverables"]);
    expect(sheet).not.toMatch(/^- \[x\]/m);
    expect(sheet).not.toMatch(/[\u200B\u202E]|\u{E0041}/u);
    expect(sheet.match(/^## /gm)).toHaveLength(1);
    expect(sheet).toContain("## \\[t\\]\\(https://e.example\\)\uFFFD (deliverables)");
    const line = sheet.split("\n").find((l) => l.includes("forged")) ?? "";
    expect(line.startsWith("- [ ] `deliverables/c1??-??x???p?forged` (Lead): See \\[x\\]")).toBe(
      true,
    );
    expect(line).toContain("\\<img src=x\\> Signal ingestion www");
    expect(line).toContain(`${"w".repeat(1900)}`);
    expect(tallySheet(sheet).unmarked).toBe(3);
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

  it("refuses a mark it does not know, and ignores lines that are not marks", () => {
    expect(() => tallySheet(sheet(["x", "?"]))).toThrow(
      "line 2: mark a claim [x], [!] or [ ], not [?]",
    );
    expect(tallySheet("# heading\n\nRead each claim `[x]`.\n").reviewed).toBe(0);
  });

  it("refuses a line that looks like a mark but is not one, so no false mark is lost", () => {
    for (const bad of [
      "- [!!] `a/2` (Overview): x",
      "- [] `a/3` (Overview): x",
      "- [ x] `a/4` (Overview): x",
      "* [!] `a/5` (Overview): x",
      "  - [!] `a/6` (Overview): x",
      "- [!]`a/7` (Overview): x",
      "-  [!] `a/9` (Overview): x",
      "- [x] not a claim line",
      "[!] `a/2` (Overview): x",
      "> - [!] `a/2` (Overview): x",
      "1. [!] `a/2` (Overview): x",
    ]) {
      expect(() => tallySheet(`- [x] \`a/1\` (Lead): y\n${bad}\n`), bad).toThrow(
        /^line 2: not a claim line as the sheet wrote it; change only the mark between \[ and \]$/,
      );
    }
    expect(() => tallySheet("- [x] `a/1` (Lead): y\n- [!] `a/1` (Lead): y\n")).toThrow(
      "line 2: claim a/1 is listed twice",
    );
  });

  it("reads a sheet saved with a byte-order mark or CRLF line ends", () => {
    const tally = tallySheet("\uFEFF- [!] `a/1` (Lead): y\r\n- [x] `a/2` (Lead): z\r\n");
    expect(tally).toMatchObject({ reviewed: 2, false: 1, falseClaims: ["a/1"] });
  });
});
