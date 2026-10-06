import { describe, expect, it } from "vitest";
import type { AuthoredCommit } from "../index/index.ts";
import type { PersonPack } from "./pack.ts";
import {
  commitFeatureLookup,
  type PersonVerifyContext,
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
      'citation "src/a.py:1-2" is not a commit; person claims cite commits only',
    ]);
    expect(problems("chronicle", claim("In March 2026, x changed.", [`commit:${OTHER}`]))).toEqual([
      `citation "commit:${OTHER}" is not one of this person's commits the pack shows; cite only those`,
    ]);
  });

  it("refuses a date outside the cited commits' dates, at the granularity stated (R18)", () => {
    const cite = [`commit:${A}`];
    expect(problems("chronicle", claim("On 14 March 2026, x changed.", cite))).toEqual([]);
    expect(problems("chronicle", claim("In March 2026, x changed.", cite))).toEqual([]);
    expect(problems("chronicle", claim("In 2026, x changed.", cite))).toEqual([]);
    expect(problems("chronicle", claim("On 15 March 2026, x changed.", cite))).toEqual([
      'the claim states "15 March 2026", outside its cited commits\' dates 2026-03-14 to 2026-03-14',
    ]);
    expect(problems("chronicle", claim("In April 2026, x changed.", cite))[0]).toMatch(/outside/);
    expect(problems("chronicle", claim("On 31 February 2026, x changed.", cite))).toEqual([
      'the claim states "31 February 2026", which is not a date',
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
      `the claim cites "commit:${A.slice(0, 12)}", which does not touch "deliverables"; cite the commits that changed it`,
    ]);
    expect(problems("areas", claim("[[nowhere]]: x.", [`commit:${A}`]))).toEqual([
      'the claim links "nowhere", which is not a feature of this wiki',
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
