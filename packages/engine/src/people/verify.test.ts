import { makeManifest } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import type { AuthoredCommit } from "../index/index.ts";
import type { IdentityGroup } from "./identities.ts";
import type { PersonPack } from "./pack.ts";
import {
  commitFeatureLookup,
  type PersonVerifyContext,
  personVerifyContext,
  statedDates,
  verifyPersonClaim,
} from "./verify.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const M = "c".repeat(40);
const OTHER = "d".repeat(40);

const commit = (sha: string, subject: string, date: string, pr: number | null = null) => ({
  sha,
  parents: [],
  date,
  subject,
  files: [],
  pr,
});

const pack = {
  personId: "ada-lovelace",
  shas: new Set([A, B, M]),
  dates: new Map([
    [A, "2026-03-14T10:00:00+01:00"],
    [B, "2026-04-02T09:00:00+01:00"],
    [M, "2026-04-03T00:00:00Z"],
  ]),
} as PersonPack;

const ctx: PersonVerifyContext = {
  verify: {
    sha: A,
    sources: new Map(),
    symbolsOf: () => [],
    commits: [
      commit(A, "feat: add scoring, by ada@example.com", "2026-03-14T10:00:00+01:00"),
      commit(B, "fix: crud paging", "2026-04-02T09:00:00+01:00", 7),
      commit(M, "Merge pull request #7", "2026-04-03T00:00:00Z", 7),
      commit(OTHER, "feat: someone else's", "2026-03-20T00:00:00Z"),
    ],
  },
  pack,
  firstCommit: "2026-03-14T10:00:00+01:00",
  lastCommit: "2026-04-03T00:00:00Z",
  otherNames: ["grace hopper", "kim hidden", "bob"],
  featuresOf: (sha) => (sha === A ? ["signals"] : sha === B || sha === M ? ["deliverables"] : []),
  features: new Set(["signals", "deliverables"]),
};

const claim = (text: string, cite: string[] = [], supports: string[] = []) => ({
  id: "x1",
  text,
  cite,
  supports,
});
const problems = (key: "lead" | "chronicle" | "areas", c: ReturnType<typeof claim>) =>
  verifyPersonClaim(key, c, ctx).problems;

describe("verifyPersonClaim (spec v2 #6 §8.4)", () => {
  it("keeps a dated chronicle claim citing the person's commit, storing its subject without emails", () => {
    const out = verifyPersonClaim(
      "chronicle",
      claim("On 14 March 2026, scoring was added to [[signals]].", [`commit:${A.slice(0, 12)}`]),
      ctx,
    );
    expect(out.problems).toEqual([]);
    expect(out.claim).toMatchObject({
      kind: "history",
      hook: false,
      citations: [{ kind: "commit", sha: A, subject: "feat: add scoring, by [email]", pr: null }],
    });
  });

  it("refuses code citations and commits the pack does not show (R17)", () => {
    expect(problems("chronicle", claim("In March 2026, x changed.", ["src/a.py:1-2"]))).toEqual([
      "citation 1 is not a commit; person claims cite commits only",
    ]);
    expect(problems("chronicle", claim("In March 2026, x changed.", [`commit:${OTHER}`]))).toEqual([
      "citation 1 is not one of this person's commits the pack shows; cite only those",
    ]);
  });

  it("refuses a date outside the cited commits' dates, at the granularity stated (R18)", () => {
    const cite = [`commit:${A}`];
    expect(problems("chronicle", claim("On 14 March 2026, x changed.", cite))).toEqual([]);
    expect(problems("chronicle", claim("In March 2026, x changed.", cite))).toEqual([]);
    expect(problems("chronicle", claim("In 2026, x changed.", cite))).toEqual([]);
    expect(problems("chronicle", claim("On 15 March 2026, x changed.", cite))).toEqual([
      "the claim states a date outside its cited commits' dates 2026-03-14 to 2026-03-14",
    ]);
    expect(problems("chronicle", claim("In April 2026, x changed.", cite))[0]).toMatch(/outside/);
    expect(problems("chronicle", claim("On 31 February 2026, x changed.", cite))).toEqual([
      "the claim states a day or month that does not exist",
    ]);
  });

  it("checks a lead's dates against the person's whole range, and needs a chronicle date", () => {
    const lead = claim("**Ada Lovelace** contributed between March and April 2026.", [], ["c1"]);
    expect(problems("lead", lead)).toEqual([]);
    expect(problems("lead", claim("**Ada** worked in May 2026.", [], ["c1"]))[0]).toMatch(
      /outside its person's dates 2026-03-14 to 2026-04-03/,
    );
    expect(problems("chronicle", claim("Scoring was added.", [`commit:${A}`]))).toEqual([
      'a chronicle claim opens with its date, such as "In March 2026,"',
    ]);
  });

  it("refuses statistics, another person's name and banned words, naming no person", () => {
    const cite = [`commit:${A}`];
    expect(problems("chronicle", claim("In March 2026, 12 commits added scoring.", cite))).toEqual([
      "the claim states a statistic; the infobox has the numbers, so leave them out",
    ]);
    const named = problems(
      "chronicle",
      claim("In March 2026, with Grace Hopper, x changed.", cite),
    );
    expect(named).toEqual(["the claim names another person; name no one but the page's subject"]);
    expect(named.join(" ")).not.toContain("Grace");
    expect(problems("chronicle", claim("In March 2026, ada@example.com changed x.", cite))).toEqual(
      ["the claim holds an email address; never write one"],
    );
    // "bob" is under four characters: a word, not a name the check looks for.
    expect(problems("chronicle", claim("In March 2026, the bob value changed.", cite))).toEqual([]);
    expect(
      problems("chronicle", claim("In March 2026, a robust, single-handedly built x.", cite)),
    ).toEqual(['the claim uses the banned words "single-handedly", "robust"']);
    // A feature id or a code span is not prose.
    expect(
      problems("chronicle", claim("In March 2026, `best` and [[signals|scoring]] changed.", cite)),
    ).toEqual([]);
  });

  it("needs an areas claim's commits to touch the one feature it links", () => {
    expect(
      problems(
        "areas",
        claim("[[deliverables|Deliverables]]: paging was added.", [`commit:${B}`, `commit:${M}`]),
      ),
    ).toEqual([]);
    expect(
      problems("areas", claim("[[deliverables]]: scoring was added.", [`commit:${A}`])),
    ).toEqual([
      `the claim cites commit:${A.slice(0, 12)}, which does not touch the feature deliverables; cite the commits that changed it`,
    ]);
    expect(problems("areas", claim("[[nowhere]]: x.", [`commit:${A}`]))).toEqual([
      "the claim links a target that is not a feature of this wiki",
    ]);
    expect(
      problems("areas", claim("[[signals]] and [[deliverables]]: x.", [`commit:${A}`])),
    ).toEqual(["an areas claim links exactly one feature"]);
  });

  it("drops a lead's citations and refuses its missing supports through core's rules", () => {
    const out = verifyPersonClaim(
      "lead",
      claim("**Ada Lovelace** contributed in 2026.", [`commit:${A}`], ["c1"]),
      ctx,
    );
    expect(out.claim?.citations).toEqual([]);
    expect(problems("lead", claim("**Ada Lovelace** contributed in 2026."))).toEqual([
      "lead claims must support at least one body claim",
    ]);
  });
});

describe("statedDates", () => {
  it("reads days, months and years, and ignores a month with no year", () => {
    expect(
      statedDates(
        "On 14 March 2026, March 3, 2026, in April 2026, 2026-05-01, 2025-12 and 2024; between January and",
      ),
    ).toEqual([
      { text: "14 March 2026", from: "2026-03-14", to: "2026-03-14" },
      { text: "March 3, 2026", from: "2026-03-03", to: "2026-03-03" },
      { text: "April 2026", from: "2026-04-01", to: "2026-04-30" },
      { text: "2026-05-01", from: "2026-05-01", to: "2026-05-01" },
      { text: "2025-12", from: "2025-12-01", to: "2025-12-31" },
      { text: "2024", from: "2024-01-01", to: "2024-12-31" },
    ]);
    expect(statedDates("31 February 2026")).toEqual([
      { text: "31 February 2026", from: "", to: "" },
    ]);
  });
});

describe("commitFeatureLookup", () => {
  it("gives a pull request's merge the features of its commits", () => {
    const authored = (sha: string, parents: string[], pr: number | null) =>
      ({ sha, parents, pr }) as AuthoredCommit;
    const lookup = commitFeatureLookup(
      [authored(M, [A, B], 7), authored(B, [A], 7), authored(A, [], null)],
      new Map([
        [A, ["signals"]],
        [B, ["deliverables"]],
      ]),
      new Map([[7, { number: 7, sha: M, title: null, mergedAt: "", merger: 0 }]]),
    );
    expect(lookup(M)).toEqual(["deliverables"]);
    expect(lookup(A)).toEqual(["signals"]);
  });
});

describe("verifyPersonClaim's checks against disguises (the Task 19 ruling)", () => {
  const cite = [`commit:${A}`];
  const one = (text: string) => problems("chronicle", claim(text, cite));
  const NAMED = "the claim names another person; name no one but the page's subject";
  const STATISTIC = "the claim states a statistic; the infobox has the numbers, so leave them out";

  it("checks names and counts inside code spans and link targets too (I1)", () => {
    expect(one("In March 2026, with `Grace Hopper`, x changed.")).toEqual([NAMED]);
    expect(one("In March 2026, with [[Grace Hopper]], x changed.")).toEqual([NAMED]);
    expect(one("In March 2026, [[signals|Grace Hopper's]] x changed.")).toEqual([NAMED]);
    expect(one("In March 2026, `12 commits` changed x.")).toEqual([STATISTIC]);
  });

  it("reads names and addresses in their normalised form (I2)", () => {
    for (const name of [
      "Grace  Hopper",
      "Grace\u00A0Hopper",
      "\uFF27race Hopper",
      "**Grace** Hopper",
      "_Grace_ Hopper",
    ])
      expect(one(`In March 2026, with ${name}, x changed.`), JSON.stringify(name)).toEqual([NAMED]);
    for (const address of [
      "ada\uFF20example.com",
      "ada\uFE6Bexample.com",
      "ada@\uFF45xample\uFF0Ecom",
    ])
      expect(one(`In March 2026, ${address} changed x.`), JSON.stringify(address)).toEqual([
        "the claim holds an email address; never write one",
      ]);
  });

  it("refuses counts in words and around adjectives, never a year's comma (I3)", () => {
    for (const text of [
      "In March 2026, three commits added scoring.",
      "In March 2026, a dozen commits added scoring.",
      "In March 2026, forty percent of scoring moved.",
      "In March 2026, 40% of scoring moved.",
      "In March 2026, 3 new files added scoring.",
      "In March 2026, 12 of the commits added scoring.",
      "In March 2026, 3 pull-requests added scoring.",
      "In March 2026, 1,200 lines moved.",
    ])
      expect(one(text), text).toEqual([STATISTIC]);
    for (const text of [
      "In March 2026, commits added scoring.",
      "On 14 March 2026, files under the parser moved.",
      "In 2026, lines of the parser moved.",
      "In 2026 the files of the parser moved.",
      "In March 2026, someone's lines moved.",
    ])
      expect(one(text), text).toEqual([]);
  });

  it("gives a range's first month the year that closes it (I5)", () => {
    expect(statedDates("between January and March 2026")).toEqual([
      { text: "January", from: "2026-01-01", to: "2026-01-31" },
      { text: "March 2026", from: "2026-03-01", to: "2026-03-31" },
    ]);
    expect(statedDates("from February to April 2026")[0]).toMatchObject({ from: "2026-02-01" });
    const lead = (text: string) => problems("lead", claim(text, [], ["c1"]));
    expect(lead("**Ada Lovelace** contributed between March and April 2026.")).toEqual([]);
    expect(lead("**Ada Lovelace** contributed between January and April 2026.")[0]).toMatch(
      /outside its person's dates 2026-03-14 to 2026-04-03/,
    );
  });

  it("refuses month 00 and day 0, and reads abbreviated months, ordinals and ISO times", () => {
    for (const text of ["2026-00", "0 March 2026", "March 0, 2026", "2026-03-00"])
      expect(statedDates(text), text).toEqual([{ text, from: "", to: "" }]);
    expect(statedDates("On 15 Mar 2026")).toEqual([
      { text: "15 Mar 2026", from: "2026-03-15", to: "2026-03-15" },
    ]);
    expect(statedDates("On 15th Sept. 2026")[0]).toMatchObject({ from: "2026-09-15" });
    expect(statedDates("On March 15th, 2026")[0]).toMatchObject({
      from: "2026-03-15",
      to: "2026-03-15",
    });
    expect(statedDates("at 2026-03-15T10:00:00Z")[0]).toMatchObject({
      from: "2026-03-15",
      to: "2026-03-15",
    });
    // A day-precise wrong date is refused, not read as the whole year.
    expect(one("On 15 Mar 2026, x changed.")[0]).toMatch(/outside/);
  });
});

describe("personVerifyContext (R17)", () => {
  const group = (name: string, excluded = false, otherNames: string[] = [], replaced = "") =>
    ({
      name,
      otherNames,
      replacedNames: replaced === "" ? [] : [replaced],
      identities: [
        { name, shownName: name, email: "x@e.com" },
        ...(replaced === "" ? [] : [{ name: replaced, shownName: name, email: "x@e.com" }]),
      ],
      excluded,
      firstCommit: "2026-03-14T10:00:00+01:00",
      lastCommit: "2026-04-03T00:00:00Z",
    }) as unknown as IdentityGroup;

  it("names every other person, excluded ones included, but none the person also bears", () => {
    const refreshed = {
      sha: A,
      commits: [],
      commitFeatures: new Map(),
      identities: {
        groups: [
          group("Ada Lovelace", false, ["Countess"]),
          group("Kim Hidden", true),
          group("Ada Lovelace"),
          group("Grace Hopper", false, ["Amazing Grace"]),
        ],
        groupOf: () => 0,
      },
    } as unknown as Parameters<typeof personVerifyContext>[0];
    const ctx = personVerifyContext(refreshed, 0, pack, makeManifest());
    expect([...ctx.otherNames].sort()).toEqual(["amazing grace", "grace hopper", "kim hidden"]);
    expect(ctx.firstCommit).toBe("2026-03-14T10:00:00+01:00");
    const kim = verifyPersonClaim(
      "chronicle",
      claim("In March 2026, with Kim Hidden, x changed.", [`commit:${A}`]),
      { ...ctx, verify: { ...ctx.verify, commits: [commit(A, "x", "2026-03-14T10:00:00+01:00")] } },
    );
    expect(kim.problems).toContain(
      "the claim names another person; name no one but the page's subject",
    );
  });
});

describe("personVerifyContext and the mailmap (the I1 ruling)", () => {
  it("lets no narrative use a name the mailmap replaced, the person's own included", () => {
    const group = (name: string, replaced: string[]) =>
      ({
        name,
        otherNames: [],
        replacedNames: replaced,
        identities: [name, ...replaced].map((raw) => ({ name: raw, shownName: name })),
        excluded: false,
        firstCommit: "2026-03-14T10:00:00+01:00",
        lastCommit: "2026-04-03T00:00:00Z",
      }) as unknown as IdentityGroup;
    const refreshed = {
      sha: A,
      commits: [],
      commitFeatures: new Map(),
      identities: {
        groups: [group("Ada Lovelace", ["Old Deadname"]), group("Grace Hopper", ["Gracie Old"])],
        groupOf: () => 0,
      },
    } as unknown as Parameters<typeof personVerifyContext>[0];
    const ctx = personVerifyContext(refreshed, 0, pack, makeManifest());
    expect([...ctx.otherNames].sort()).toEqual(["grace hopper", "gracie old", "old deadname"]);
  });
});

describe("verifyPersonClaim's problems (the Task 19 ruling, I4)", () => {
  it("never quote the model's text: a name, a path or an address in a citation or link", () => {
    const out = [
      ...problems("chronicle", claim("In March 2026, x changed.", ["src/Grace Hopper.py:1-2"])),
      ...problems("chronicle", claim("In March 2026, x changed.", ["grace@example.com:1-2"])),
      ...problems("chronicle", claim("In March 2026, x changed.", ["commit:Grace Hopper"])),
      ...problems("chronicle", claim("In March 2026, x changed.", ["commit:abc"])),
      ...problems("areas", claim("[[Grace Hopper]]: x changed.", [`commit:${A}`])),
      ...problems("areas", claim("[[grace-hopper]]: x changed.", [`commit:${A}`])),
      ...problems(
        "chronicle",
        claim(`In March 2026, Grace Hopper wrote src/a.py:1-2.`, [`commit:${A}`]),
      ),
    ];
    expect(out.length).toBeGreaterThan(6);
    expect(out.join("\n")).not.toMatch(/grace|hopper|example|src\/a/i);
  });
});
