import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PeopleConfig } from "@repowiki/core";
import { configuredEmail, readPeople } from "@repowiki/engine";
import {
  ADA,
  KIM,
  PEOPLE_SECRETS,
  type PeopleFixture,
  peopleFixture,
} from "@repowiki/engine/test-people";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attributesNotes,
  DEFAULT_PEOPLE_MAX_USD,
  exclusionNotes,
  loadPeopleFile,
  narrativeCeilingUsd,
  ownerEmailOf,
  parsePeopleArgs,
  parseSuggestArgs,
  parseUsd,
  peopleFilePath,
  renderPeopleSummary,
  renderSuggest,
  withinBudget,
} from "./people-cli.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("parseSuggestArgs", () => {
  it("reads the repo, --out and --people-file", () => {
    expect(parseSuggestArgs(["r", "--out", "o", "--people-file", "p.json"])).toEqual({
      repo: "r",
      out: "o",
      peopleFile: "p.json",
    });
    expect(parseSuggestArgs(["r"])).toEqual({ repo: "r", out: null, peopleFile: null });
  });

  it.each([[[]], [["r", "s"]], [["r", "--out", "a", "--out", "b"]], [["r", "--max-usd", "1"]]])(
    "refuses %j as a usage error",
    (argv) => {
      expect(() => parseSuggestArgs(argv)).toThrow(/usage: pnpm people:suggest/);
    },
  );
});

describe("the people file (spec v2 #6 R9)", () => {
  let fx: PeopleFixture;
  beforeEach(async () => {
    fx = await peopleFixture();
  });
  afterEach(() => fx.remove());

  it("defaults to <out>/people.json and refuses one inside the repository, even through a link", () => {
    expect(peopleFilePath(fx.repo.dir, fx.out, null)).toMatch(/out\/people\.json$/);
    expect(() => peopleFilePath(fx.repo.dir, fx.out, join(fx.repo.dir, "people.json"))).toThrow(
      /inside the documented repository/,
    );
    writeFileSync(join(fx.repo.dir, "people.json"), "{}");
    symlinkSync(join(fx.repo.dir, "people.json"), join(fx.out, "people.json"));
    expect(() => peopleFilePath(fx.repo.dir, fx.out, null)).toThrow(/inside the documented/);
  });

  it("reads every default when there is no file, and lists a bad file's problems without its emails", () => {
    expect(loadPeopleFile(join(fx.out, "none.json"))).toEqual(PeopleConfig.parse({}));
    const bad = join(fx.out, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(() => loadPeopleFile(bad)).toThrow(/is not a JSON people file/);
    writeFileSync(bad, JSON.stringify({ exclude: ["email:kim.q7hidden@example.com"], extra: 1 }));
    try {
      loadPeopleFile(bad);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toMatch(/unknown key/);
      expect(String(err)).not.toContain("q7hidden");
    }
  });
});

describe("renderSuggest (spec v2 #6 §6 step 6)", () => {
  let fx: PeopleFixture;
  beforeEach(async () => {
    fx = await peopleFixture();
    // Kim once committed with her address as her name: it must give no key and show nowhere.
    fx.repo.write("docs/kim.md", "kim\n");
    fx.repo.commit("docs: kim", "+0000", { name: KIM.email, email: KIM.email });
    // A handle for Kim Hidden from another address: suggested, never applied (R8).
    fx.repo.write("docs/more.md", "more\n");
    fx.head = fx.repo.commit("docs: more", "+0000", {
      name: "kimh",
      email: "kimh.q7other@example.com",
    });
  });
  afterEach(() => fx.remove());

  const render = (file: unknown = {}) => {
    const config = PeopleConfig.parse(file);
    const read = readPeople({
      repo: fx.repo.dir,
      sha: fx.head,
      store: fx.store,
      config,
      ownerEmail: configuredEmail(fx.repo.dir),
    });
    return renderSuggest(read, config);
  };

  it("lists each person with masked emails, logins, commits and narrative consent", () => {
    const text = render();
    expect(text).toContain("`ada-lovelace`");
    expect(text).toContain("`a…@example.com`");
    expect(text).toContain("`bob-q7login`");
    expect(text).toMatch(/`dependabot-bot` \(bot\)/);
    // Ada is the owner (the repository's user.email); nobody else consented.
    expect(text).toMatch(/`Ada Lovelace`.*\| yes \(owner\) \|/);
    expect(text).toMatch(/`bob`.*\| no \|/);
    for (const secret of PEOPLE_SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain("q7other");
  });

  it("suggests the handle merge with a name-keys-only entry, and applies nothing", () => {
    const text = render();
    expect(text).toContain("`kimh` and `Kim Hidden`: handle = first name + last initial");
    expect(text).toContain('{"name":"Kim Hidden","match":["name:kim hidden","name:kimh"]}');
    expect(text).toContain("A name of kim-hidden gives no name key");
    expect(text).toMatch(/`kimh`.*\| no \|/);
    for (const secret of PEOPLE_SECRETS) expect(text).not.toContain(secret);
  });

  it("shows only the names after the mailmap, with a count of those it replaced (I1)", () => {
    fx.repo.write(".mailmap", `Ada Lovelace <${ADA.email}>\n`);
    fx.head = fx.repo.commit("docs: an old name", "+0000", {
      name: "Old Deadname",
      email: ADA.email,
    });
    const text = render();
    expect(text).not.toMatch(/deadname/i);
    expect(text).toMatch(
      /`ada-lovelace` \| `Ada Lovelace` \| \(1 name replaced by the mailmap\) \|/,
    );
  });

  it("flags a person whose identities look like bots only in part", () => {
    fx.repo.write("docs/bot.md", "bot\n");
    fx.head = fx.repo.commit("chore: bot run", "+0000", { name: "dependabot", email: ADA.email });
    const text = render();
    expect(text).toMatch(/`ada-lovelace` \(mixed bot\) \| `Ada Lovelace`/);
    expect(text).toContain('A "(mixed bot)" person has identities that look like bots');
    expect(render({ humans: ["name:dependabot"] })).not.toContain("(mixed bot)");
  });

  it("says no to a consenting person past maxNarratives in rank", () => {
    const consent = { minCommits: 2, people: [{ match: ["login:bob-q7login"], narrative: true }] };
    const capped = render({ ...consent, maxNarratives: 1 });
    // Ada (3 commits) ranks before bob (2): only she fits a cap of one.
    expect(capped).toMatch(/`Ada Lovelace`.*\| yes \(owner\) \|/);
    expect(capped).toMatch(/`bob`.*\| no \(over the cap of 1\) \|/);
    expect(render({ ...consent, maxNarratives: 0 })).toMatch(
      /`Ada Lovelace`.*\| no \(over the cap of 0\) \|/,
    );
  });

  it("marks an excluded person and a people-file narrative", () => {
    const text = render({
      exclude: ["name:Kim Hidden"],
      people: [{ match: ["login:bob-q7login"], narrative: true }],
    });
    expect(text).toMatch(/\| excluded \|/);
    expect(text).not.toContain("kim-hidden");
    // Two commits are below minCommits (3), so even consent gives bob no narrative...
    expect(text).toMatch(/`bob`.*\| no \|/);
    // ...until the owner lowers it.
    const lowered = render({
      minCommits: 2,
      people: [{ match: ["login:bob-q7login"], narrative: true }],
    });
    expect(lowered).toMatch(/`bob`.*\| yes \(people file\) \|/);
  });
});

describe("parsePeopleArgs (spec v2 #6 §10)", () => {
  it("reads every flag, with --only repeated, and defaults to narratives on and $1", () => {
    expect(parsePeopleArgs(["r"])).toEqual({
      repo: "r",
      out: null,
      peopleFile: null,
      config: null,
      narrative: true,
      only: [],
      rebuildBlame: false,
      batch: true,
      maxUsd: DEFAULT_PEOPLE_MAX_USD,
      dryRun: false,
      disable: false,
      forget: null,
      verbose: false,
    });
    const args = parsePeopleArgs([
      "r",
      "--only",
      "ada-lovelace",
      "--only",
      "kim-filler",
      "--no-narrative",
      "--rebuild-blame",
      "--no-batch",
      "--max-usd",
      "0.25",
      "--dry-run",
    ]);
    expect(args).toMatchObject({
      only: ["ada-lovelace", "kim-filler"],
      narrative: false,
      rebuildBlame: true,
      batch: false,
      maxUsd: 0.25,
      dryRun: true,
    });
    expect(parsePeopleArgs(["r", "--forget", "name:Someone Private"]).forget).toBe(
      "name:Someone Private",
    );
  });

  it.each([
    [["r", "--only", "Ada Lovelace"], /--only takes a person id/],
    [["r", "--max-usd", "0"], /--max-usd must be a number/],
    [["r", "--max-usd", "1e3"], /--max-usd must be a number/],
    [["r", "--max-usd", "101"], /up to 100/],
    [["r", "--forget", "nobody"], /--forget takes a people-file match key/],
    [["r", "--disable", "--dry-run"], /--disable takes no other run flag/],
    [["r", "--forget", "name:x", "--only", "a"], /--forget takes no other run flag/],
    [["r", "--disable", "--forget", "name:x"], /--disable takes no other run flag/],
    [["r", "--dry-run", "--dry-run"], /usage/],
  ])("refuses %j", (argv, message) => {
    expect(() => parsePeopleArgs(argv)).toThrow(message);
  });

  it("never echoes an email key's value", () => {
    try {
      parsePeopleArgs(["r", "--forget", "email:not an address q7x"]);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("q7x");
    }
  });
});

describe("the People estimate and ceiling (R26)", () => {
  it("prices a call and a retry at their output caps, halved when batched (the Task 23 ruling)", () => {
    const batched = narrativeCeilingUsd(3000, 5000, "claude-haiku-4-5", true);
    expect(narrativeCeilingUsd(3000, 5000, "claude-haiku-4-5", false)).toBeCloseTo(2 * batched);
    // (5k + 3k + 2.5k) in, then a retry resending a 6k draft: (5k + 3k + 6k) in; 6k + 6k out,
    // since a whole retry can write 6,000 (the wave B ruling); at $1/$5 per MTok, halved.
    expect(batched).toBeCloseTo((24_500 * 1 + 12_000 * 5) / 1e6 / 2);
    // A cache key makes the first call write the system prompt at $1.25 instead of $1.
    expect(narrativeCeilingUsd(3000, 5000, "claude-haiku-4-5", true, true)).toBeCloseTo(
      batched + (5_000 * 0.25) / 1e6 / 2,
    );
    expect(() => narrativeCeilingUsd(1, 1, "constructor", true)).toThrow(/no price for model/);
    expect(parseUsd("--people-max-usd", undefined, 0.5, "u")).toBe(0.5);
  });

  it("fails closed on a cost that is not a finite, non-negative number", () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY])
      expect(
        withinBudget([bad, 0.1], (n: number) => n, 1),
        String(bad),
      ).toEqual({
        taken: [],
        over: [bad, 0.1],
        usd: 0,
      });
    expect(withinBudget([0.5, 0.5], (n: number) => n, 1).taken).toEqual([0.5, 0.5]);
  });

  it("takes narratives in rank order while the next fits", () => {
    const cost = (n: number) => n;
    expect(withinBudget([0.4, 0.4, 0.3], cost, 1)).toEqual({
      taken: [0.4, 0.4],
      over: [0.3],
      usd: 0.8,
    });
    expect(withinBudget([2, 0.1], cost, 1)).toEqual({ taken: [], over: [2, 0.1], usd: 0 });
  });
});

describe("renderPeopleSummary", () => {
  it("lists each person in code spans, the notes, and the cost block", () => {
    const text = renderPeopleSummary(
      "demo",
      "a".repeat(40),
      [
        {
          id: "ada-lovelace",
          name: "Ada | Lovelace",
          kind: "human",
          commits: 1200,
          narrative: "written",
          dropped: 1,
        },
        {
          id: "dependabot-bot",
          name: "dependabot[bot]",
          kind: "bot",
          commits: 3,
          narrative: "none (bot)",
          dropped: 0,
        },
      ],
      exclusionNotes(1, true),
      {
        calls: 1,
        batchCalls: 1,
        tokens: { in: 10, out: 5, cacheRead: 0, cacheWrite: 0 },
        usd: 0.01,
        unpricedCalls: 0,
      },
      0.02,
    );
    expect(text).toContain("# People: `demo` at aaaaaaa");
    expect(text).toContain("| `ada-lovelace` | `Ada \\| Lovelace` | 1,200 | written | 1 |");
    expect(text).toContain("| `dependabot-bot` (bot) |");
    expect(text).toContain("is theirs by elimination");
    expect(text).toContain("Cost: $0.0100 (estimated up front: at most $0.0200).");
  });

  it("prints no address from a repo name, a status or a note", () => {
    const text = renderPeopleSummary(
      "ada@example.com",
      "a".repeat(40),
      [
        {
          id: "ada-lovelace",
          name: "Ada",
          kind: "human",
          commits: 1,
          narrative: "failed, computed lead kept: kim@example.org",
          dropped: 0,
        },
      ],
      ["A note naming bob@example.net."],
      {
        calls: 0,
        batchCalls: 0,
        tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
        usd: 0,
        unpricedCalls: 0,
      },
      null,
    );
    expect(text).not.toMatch(/@example/);
    expect(text).toContain("[email]");
  });

  it("says nothing of exclusion when nobody is excluded", () => {
    expect(exclusionNotes(0, false)).toEqual([]);
    expect(exclusionNotes(2, true)).toHaveLength(1);
    // Two excluded, one of them merge-only: the series is still one person's.
    expect(exclusionNotes(2, true, 1)).toHaveLength(2);
  });
});

describe("attributesNotes (the fix-forward ruling on --attr-source)", () => {
  it("notes work-tree attributes only when git cannot read them at the sha", () => {
    expect(attributesNotes(true)).toEqual([]);
    expect(attributesNotes(false)).toEqual([
      "Attributes from the work tree may apply: this git (before 2.40) cannot read .gitattributes at the sha, so line counts may follow the work tree's.",
    ]);
  });
});

describe("ownerEmailOf (the fix-forward ruling on the owner lookup)", () => {
  it("notes a git failure once instead of passing it off as no owner", () => {
    const lines: string[] = [];
    expect(ownerEmailOf("/no/such/repository/x", (line) => lines.push(line))).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^owner not found: /);
  });
});
