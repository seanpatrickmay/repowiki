import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PeopleConfig } from "@repowiki/core";
import { configuredEmail, readPeople } from "@repowiki/engine";
import { PEOPLE_SECRETS, type PeopleFixture, peopleFixture } from "@repowiki/engine/test-people";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPeopleFile, parseSuggestArgs, peopleFilePath, renderSuggest } from "./people-cli.ts";

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
