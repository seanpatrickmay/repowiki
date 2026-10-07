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
  it("shows at most the first character of the local part, and the domain", () => {
    expect(maskEmail("wyatt.brown@uni.example")).toBe("w…@uni.example");
    expect(maskEmail("abc@x.io")).toBe("a…@x.io");
    // A local part under three characters shows nothing of itself.
    expect(maskEmail("ab@x.io")).toBe("…@x.io");
    expect(maskEmail("a@x.io")).toBe("…@x.io");
    expect(maskEmail("not-an-email")).toBe("…");
  });

  it("strips control and invisible characters from the address it masks", () => {
    expect(maskEmail("\u001b[31mve@ex\u202Eample.com\u0085")).toBe("[…@example.com");
    expect(maskEmail("\u200Beve@ex\u00ADample.com")).toBe("e…@example.com");
    expect(maskEmail("eve@\u001b]8;;x\u0007.com")).toBe("e…@]8;;x.com");
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
    const lines = suggestionSnippet(team, ["a", "b"], suggestion);
    expect(lines).toHaveLength(1);
    const snippet = lines[0] ?? "";
    expect(JSON.parse(snippet)).toEqual({
      name: "Wyatt Brown",
      match: ["name:wyatt brown", "name:wyattb"],
    });
    expect(snippet).not.toContain("@");
  });

  it("builds keys from cleaned names: a name holding an address gives no key, and the snippet says to add that person by id", () => {
    const team = groups([
      by("wyattb", "w1@e.com", 1),
      by("Wyatt Brown", "wyatt.q7secret@e.com", 2),
      by("wyatt.q7secret@e.com", "wyatt.q7secret@e.com", 3),
    ]);
    const [suggestion] = suggestMerges(team);
    if (suggestion === undefined) throw new Error("expected a suggestion");
    const ids = team.map((_, i) => `person-${i}`);
    const lines = suggestionSnippet(team, ids, suggestion);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      name: "Wyatt Brown",
      match: ["name:wyatt brown", "name:wyattb"],
    });
    expect(lines.slice(1)).toEqual([
      `A name of ${ids[suggestion.name]} gives no name key: add that person's other keys to the entry by hand (people:suggest never prints an address).`,
    ]);
    expect(lines.join("\n")).not.toContain("q7secret");
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
