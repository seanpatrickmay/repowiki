import { describe, expect, it } from "vitest";
import {
  CalendarDay,
  cleanPersonName,
  cleanPullTitle,
  PeopleSnapshot,
  PersonFacts,
  PersonId,
  PersonName,
} from "./person.ts";
import { withoutEmails } from "./plain-text.ts";
import { makePeopleSnapshot, makePersonFacts } from "./test-fixtures.ts";

describe("PersonId", () => {
  it("is a kebab-case slug of at most 64 characters", () => {
    for (const id of ["ada-lovelace", "person-2", "x"]) expect(PersonId.parse(id)).toBe(id);
    for (const id of ["Ada", "ada--lovelace", "-ada", "ada_l", "", "a".repeat(65)])
      expect(PersonId.safeParse(id).success, id).toBe(false);
  });
});

describe("cleanPersonName (spec v2 #6 §6.1, R14)", () => {
  it("drops control, bidi and invisible characters and collapses whitespace", () => {
    expect(cleanPersonName("  Ada\u202E \u200BLove\u00ADlace\t ")).toBe("Ada Lovelace");
    expect(cleanPersonName("Zo\u200Dë")).toBe("Zo\u200Dë");
  });

  it("makes every whitespace character a space, NEL and the line separators included", () => {
    expect(cleanPersonName("ADA\tLovelace")).toBe("ADA Lovelace");
    for (const space of ["\n", "\r\n", "\u0085", "\u2028", "\u2029", "\u00A0"])
      expect(cleanPersonName(`Ada${space}Lovelace`), JSON.stringify(space)).toBe("Ada Lovelace");
  });

  it("makes a name holding an address in any disguise unusable", () => {
    for (const name of [
      "ada\uFF20example.com",
      "ada\uFE6Bexample.com",
      "ada@example\uFF0Ecom",
      '"ada"@example.com',
      "ada(work)@example.com",
      "o'brien@example.com",
      "ada\t@example.com",
      "ada\u0085@example.com",
      "Ada @ example.com",
      "ada@exa\u00ADmple.com",
      "kim.q7hidden\u200D@example.com",
      "kim.q7hidden@\u200Cexample.com",
      "kim.q7hidden@example\u200D.com",
    ])
      expect(cleanPersonName(name), JSON.stringify(name)).toBe("");
  });

  it("makes a name with no visible character, or a lone surrogate's, safe", () => {
    for (const blank of ["\u200D", "\u200C \u200D", "\u3164", "\u2800", "\u034F", "\uFE0F"])
      expect(cleanPersonName(blank), JSON.stringify(blank)).toBe("");
    for (const blank of ["\uFFFC", "\u0301", `${"\u0301".repeat(130)}a`])
      expect(cleanPersonName(blank), JSON.stringify(blank)).toBe("");
    expect(cleanPersonName("Ada\uD800")).toBe("Ada\uFFFD");
    expect(PersonName.safeParse("Ada\uD800").success).toBe(false);
    expect(PersonName.safeParse("\u200D").success).toBe(false);
  });

  it("cuts a long name to 120 code points, never splitting an astral character", () => {
    expect([...cleanPersonName("a".repeat(500))]).toHaveLength(120);
    expect([...cleanPersonName("\u{1F600}".repeat(130))]).toHaveLength(120);
  });

  it("keeps markup as text, for each medium to escape", () => {
    expect(cleanPersonName("<script>x</script> [[signals]] **b**")).toBe(
      "<script>x</script> [[signals]] **b**",
    );
  });

  it("makes a name holding an email address, or nothing visible, unusable", () => {
    expect(cleanPersonName("Ada <ada@example.com>")).toBe("");
    expect(cleanPersonName("ada@example.com")).toBe("");
    expect(cleanPersonName("\u200B\u202E ")).toBe("");
  });

  it("is idempotent, and PersonName accepts only its output", () => {
    for (const raw of ["Ada  Lovelace", "\u202Eada", "x".repeat(200)]) {
      const once = cleanPersonName(raw);
      expect(cleanPersonName(once)).toBe(once);
      expect(PersonName.safeParse(once).success).toBe(true);
    }
    expect(PersonName.safeParse(" Ada").success).toBe(false);
    expect(PersonName.safeParse("").success).toBe(false);
    expect(PersonName.safeParse("a@b.co").success).toBe(false);
  });
});

describe("withoutEmails and cleanPullTitle (planner ruling R5)", () => {
  it("replaces every email-shaped token", () => {
    expect(withoutEmails("Merge from ada@example.com and <g.h@x.io>")).toBe(
      "Merge from [email] and <[email]>",
    );
    expect(withoutEmails("Use @decorator and a@b")).toBe("Use @decorator and a@b");
  });

  it("makes a title one cleaned line of at most 200 code points, or null when empty", () => {
    expect(cleanPullTitle("Fix\nthe\u202E parser  for a@b.io")).toBe("Fix the parser for [email]");
    expect([...(cleanPullTitle("t".repeat(300)) ?? "")]).toHaveLength(200);
    expect(cleanPullTitle(" \u0085 ")).toBeNull();
    for (const joined of ["kim.q7hidden\u200D@example.com", "kim.q7hidden@example\u200C.com"])
      expect(cleanPullTitle(`Fix for ${joined}`), JSON.stringify(joined)).toBe("Fix for [email]");
  });

  it("removes an address before blanking, so an invisible character cannot split it", () => {
    expect(cleanPullTitle("Fix for ada\u200B@example.com")).toBe("Fix for [email]");
    expect(cleanPullTitle("Fix for ada@exa\u00ADmple.com")).toBe("Fix for [email]");
    expect(cleanPullTitle("Fix ada@example\u0085.com")).toBe("Fix [email]");
    expect(cleanPullTitle("Fix ada\uFF20example\uFF0Ecom")).toBe("Fix [email]");
    expect(cleanPullTitle("Fix\u2028the\u0085parser")).toBe("Fix the parser");
  });

  it("gives null for a title with nothing visible, and keeps a lone surrogate out", () => {
    for (const blank of ["\u200D", "\u3164 \u2800", "\uFE0F\u034F", "\uFFFC", "\u0301"])
      expect(cleanPullTitle(blank), JSON.stringify(blank)).toBeNull();
    expect(cleanPullTitle("Fix \uD800")).toBe("Fix \uFFFD");
    const long = cleanPullTitle(`${"t".repeat(198)}\u{1F600}\u{1F600}x`) ?? "";
    expect(long.toWellFormed()).toBe(long);
    expect(cleanPullTitle(long)).toBe(long);
  });
});

describe("CalendarDay", () => {
  it("accepts real dates only", () => {
    expect(CalendarDay.parse("2024-02-29")).toBe("2024-02-29");
    for (const day of ["2026-02-29", "2026-13-01", "2026-1-01", "20260101"])
      expect(CalendarDay.safeParse(day).success, day).toBe(false);
  });
});

describe("PersonFacts", () => {
  it("accepts the fixture", () => {
    expect(PersonFacts.parse(makePersonFacts())).toEqual(makePersonFacts());
  });

  it("refuses unsorted other names, a name among them, and unsorted features or activity", () => {
    const bad = [
      makePersonFacts({ otherNames: ["b", "a"] }),
      makePersonFacts({ otherNames: ["Ada Lovelace"] }),
      makePersonFacts({
        features: [
          { featureId: "deliverables", commits: 1, currentLines: 10 },
          { featureId: "signals", commits: 3, currentLines: 80 },
        ],
      }),
      makePersonFacts({
        activity: [
          { day: "2026-02-10", commits: 1, added: 0, deleted: 0 },
          { day: "2026-01-05", commits: 1, added: 0, deleted: 0 },
        ],
      }),
      makePersonFacts({ prsMerged: [4, 3] }),
      makePersonFacts({ features: [{ featureId: "signals", commits: 0, currentLines: 0 }] }),
      makePersonFacts({ firstCommit: "2026-04-01T00:00:00Z" }),
    ];
    for (const facts of bad) expect(PersonFacts.safeParse(facts).success).toBe(false);
  });
});

describe("PeopleSnapshot", () => {
  it("accepts the fixture", () => {
    expect(PeopleSnapshot.parse(makePeopleSnapshot())).toEqual(makePeopleSnapshot());
  });

  it("refuses unsorted people, a redirect from a person or to a bot, and lines that do not add up", () => {
    const [ada, bot, grace] = makePeopleSnapshot().people;
    const bad = [
      makePeopleSnapshot({ people: [grace, ada, bot] as never }),
      makePeopleSnapshot({ redirects: [{ from: "grace-hopper", to: "ada-lovelace" }] }),
      makePeopleSnapshot({ redirects: [{ from: "old", to: "dependabot" }] }),
      makePeopleSnapshot({ redirects: [{ from: "old", to: "nobody" }] }),
      makePeopleSnapshot({ unattributedLines: 41 }),
      makePeopleSnapshot({ featureLines: { signals: 200, deliverables: 40 } }),
    ];
    for (const snapshot of bad) expect(PeopleSnapshot.safeParse(snapshot).success).toBe(false);
  });
});
