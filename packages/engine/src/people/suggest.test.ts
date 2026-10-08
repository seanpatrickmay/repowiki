import { PeopleConfig } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import type { AuthoredCommit } from "../index/index.ts";
import { resolveIdentities, wantsNarrative } from "./identities.ts";
import { parseMailmap } from "./mailmap.ts";
import { maskEmail, suggestionSnippet, suggestMerges } from "./suggest.ts";

let n = 0;
function by(name: string, email: string, day = 1): AuthoredCommit {
  n++;
  const date = `2026-03-${String(day).padStart(2, "0")}T12:00:00Z`;
  return {
    sha: n.toString(16).padStart(40, "0"),
    parents: ["0".repeat(40)],
    authorName: name,
    authorEmail: email,
    authorDate: date,
    commitDate: date,
    subject: "x",
    mergeTitle: null,
    files: [],
    pr: null,
  };
}

const groups = (commits: AuthoredCommit[], file: unknown = {}, ownerEmail: string | null = null) =>
  resolveIdentities({
    commits,
    mailmap: parseMailmap(""),
    config: PeopleConfig.parse(file),
    salt: "1".repeat(64),
    ownerEmail,
  }).groups;

describe("maskEmail (spec v2 #6 R10)", () => {
  it("shows three characters of the local part and the domain", () => {
    expect(maskEmail("wyatt.brown@uni.example")).toBe("wya…@uni.example");
    expect(maskEmail("ab@x.io")).toBe("ab…@x.io");
    expect(maskEmail("not-an-email")).toBe("…");
  });
});

describe("suggestMerges (spec v2 #6 R8)", () => {
  it("suggests each handle rule and the email rule, never applying them", () => {
    const team = groups([
      by("wyattb", "w1@e.com", 1),
      by("Wyatt Brown", "w2@e.com", 2),
      by("priya.patel", "p1@e.com", 3),
      by("Priya Patel", "p2@e.com", 4),
      by("dramos", "d1@e.com", 5),
      by("Diego Ramos", "d2@e.com", 6),
      by("mei", "m1@e.com", 7),
      by("Mei Chen", "mei@uni.example", 8),
    ]);
    const shown = suggestMerges(team).map((s) => [
      team[s.handle]?.name,
      team[s.name]?.name,
      s.rule,
    ]);
    expect(shown).toEqual([
      ["wyattb", "Wyatt Brown", "handle = first name + last initial"],
      ["priya.patel", "Priya Patel", "handle = first.last"],
      ["dramos", "Diego Ramos", "handle = first initial + last name"],
      ["mei", "Mei Chen", "an email's local part is the handle"],
    ]);
    expect(team).toHaveLength(8);
  });

  it("never suggests a bot or an excluded person", () => {
    const team = groups([by("wyattb", "w1@e.com", 1), by("Wyatt Brown", "w2@e.com", 2)], {
      exclude: ["name:Wyatt Brown"],
    });
    expect(suggestMerges(team)).toEqual([]);
  });

  it("writes a snippet with name keys only", () => {
    const team = groups([by("wyattb", "w1@e.com", 1), by("Wyatt Brown", "w2@e.com", 2)]);
    const [suggestion] = suggestMerges(team);
    if (suggestion === undefined) throw new Error("expected a suggestion");
    const snippet = suggestionSnippet(team, suggestion);
    expect(JSON.parse(snippet)).toEqual({
      name: "Wyatt Brown",
      match: ["name:wyatt brown", "name:wyattb"],
    });
    expect(snippet).not.toContain("@");
  });
});

describe("wantsNarrative (the v2 consent ruling)", () => {
  const commits = [
    ...Array.from({ length: 3 }, (_, i) => by("Owner One", "owner@e.com", i + 1)),
    ...Array.from({ length: 3 }, (_, i) => by("Mate Two", "mate@e.com", i + 1)),
    by("Brief Three", "brief@e.com", 9),
  ];
  const wanted = (file: unknown = {}, owner: string | null = "owner@e.com") => {
    const config = PeopleConfig.parse(file);
    return groups(commits, file, owner)
      .filter((g) => wantsNarrative(g, config))
      .map((g) => g.name)
      .sort();
  };

  it("writes only the owner's by default", () => {
    expect(wanted()).toEqual(["Owner One"]);
    expect(wanted({}, null)).toEqual([]);
  });

  it("writes a teammate's only when the people file says narrative: true", () => {
    expect(wanted({ people: [{ match: ["name:mate two"], narrative: true }] })).toEqual([
      "Mate Two",
      "Owner One",
    ]);
  });

  it("lets the owner turn their own off, and keeps minCommits", () => {
    expect(wanted({ people: [{ match: ["name:owner one"], narrative: false }] })).toEqual([]);
    expect(wanted({ people: [{ match: ["name:brief three"], narrative: true }] })).toEqual([
      "Owner One",
    ]);
    expect(wanted({ minCommits: 4 })).toEqual([]);
  });
});
