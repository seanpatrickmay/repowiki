import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PeopleConfig } from "@repowiki/core";
import { configuredEmail, readPeople } from "@repowiki/engine";
import { PEOPLE_SECRETS, type PeopleFixture, peopleFixture } from "@repowiki/engine/test-people";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PEOPLE_MAX_USD,
  exclusionNotes,
  loadPeopleFile,
  narrativeCeilingUsd,
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
    expect(text).toContain("`ada…@example.com`");
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
    expect(text).toMatch(/`kimh`.*\| no \|/);
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
  it("prices a call and a retry, halved when batched", () => {
    const batched = narrativeCeilingUsd(3000, 5000, "claude-haiku-4-5", true);
    expect(narrativeCeilingUsd(3000, 5000, "claude-haiku-4-5", false)).toBeCloseTo(2 * batched);
    // 2 x (5k + 3k) + 2.5k in, 5k out at $1/$5 per MTok, halved: about two cents.
    expect(batched).toBeCloseTo((18_500 * 1 + 5_000 * 5) / 1e6 / 2);
    expect(parseUsd("--people-max-usd", undefined, 0.5, "u")).toBe(0.5);
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

  it("says nothing of exclusion when nobody is excluded", () => {
    expect(exclusionNotes(0, false)).toEqual([]);
    expect(exclusionNotes(2, true)).toHaveLength(1);
  });
});
