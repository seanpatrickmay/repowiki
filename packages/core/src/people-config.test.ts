import { describe, expect, it } from "vitest";
import {
  normalizeName,
  PeopleConfig,
  parseMatchKey,
  parsePeopleConfig,
  shownMatchKey,
} from "./people-config.ts";

describe("match keys (spec v2 #6 §5)", () => {
  it("normalises names, emails and logins the way identities are compared", () => {
    expect(parseMatchKey("name:  Ada  LOVELACE ")).toEqual({
      kind: "name",
      value: "ada lovelace",
    });
    expect(parseMatchKey("email: Ada@Example.COM")).toEqual({
      kind: "email",
      value: "ada@example.com",
    });
    expect(parseMatchKey("login:Octo-Dev")).toEqual({ kind: "login", value: "octo-dev" });
    expect(parseMatchKey("login:dependabot[bot]")).toEqual({
      kind: "login",
      value: "dependabot[bot]",
    });
  });

  it("refuses an unknown kind, an empty value, a bad email or login, and no colon", () => {
    for (const key of ["id:ada", "name:", "name:\u200B", "email:ada", "login:a b", "ada"])
      expect(parseMatchKey(key), key).toBeNull();
  });

  it("compares names case- and width-insensitively", () => {
    expect(normalizeName("ＡＤＡ\tLovelace")).toBe("ada lovelace");
    // Whitespace is a space as cleanPersonName makes it, so a key and a display name agree.
    expect(normalizeName("Ada\u0085Love\u2028lace\u3164")).toBe("ada love lace");
  });

  it("shows a key in a message without an email's value", () => {
    expect(shownMatchKey("email:ada@example.com")).toBe("an email: key");
    expect(shownMatchKey("name:Ada Lovelace")).toBe("name:ada lovelace");
    // A name key can hold an address, as an author's name can: its value is redacted too.
    expect(shownMatchKey("name:Ada@Example.com")).toBe("name:[email]");
    expect(shownMatchKey("name:Ada\uFF20example.com")).toBe("name:[email]");
    expect(shownMatchKey("nope")).toBe("a malformed key");
  });
});

describe("PeopleConfig (spec v2 #6 R9)", () => {
  it("fills every default", () => {
    expect(PeopleConfig.parse({})).toEqual({
      people: [],
      exclude: [],
      bots: [],
      humans: [],
      minCommits: 3,
      maxNarratives: 25,
      ignoreRevs: true,
      othersMinPeople: 1,
    });
  });

  it("reads the spec's example, with the narrative flag and the owner's keys", () => {
    const file = {
      people: [
        {
          name: "Wyatt Example",
          id: "wyatt-example",
          match: ["name:wyattx", "login:wexample"],
          narrative: true,
        },
      ],
      exclude: ["name:Someone Private"],
      bots: ["name:release-runner"],
      owner: ["email:owner@example.com"],
      minCommits: 5,
    };
    const parsed = PeopleConfig.parse(file);
    expect(parsed.people[0]?.narrative).toBe(true);
    expect(parsed.owner).toEqual(["email:owner@example.com"]);
    expect(parsed.minCommits).toBe(5);
  });

  it("keeps owner: [] apart from no owner key: an explicit empty list names no owner", () => {
    expect(PeopleConfig.parse({ owner: [] }).owner).toEqual([]);
    expect(PeopleConfig.parse({}).owner).toBeUndefined();
  });

  it("says where a bad file is wrong without repeating an email or an odd key", () => {
    const result = parsePeopleConfig({
      people: [{ match: ["email:secret.person@example.com", "nope"], extra: 1 }],
      "secret@example.com": true,
      minCommits: 0,
    });
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      "people[0].match[1]: expected name:<text>, email:<address> or login:<github-login>",
      "people[0]: unknown key extra",
      "minCommits: Too small: expected number to be >=1",
      "the people file: unknown key ?",
    ]);
    expect(result.problems.join("\n")).not.toContain("secret");
  });

  it("refuses a key in two groups, in a group and exclude, or in bots and humans", () => {
    const twice = parsePeopleConfig({
      people: [{ match: ["email:x@example.com"] }, { match: ["email:X@example.com "] }],
    });
    expect(twice.problems).toEqual([
      "people[0].match[0] (an email: key) is also people[1].match[0]",
    ]);
    const excluded = parsePeopleConfig({
      people: [{ match: ["name:Ada"] }],
      exclude: ["name:ada"],
    });
    expect(excluded.problems).toEqual(["people[0].match[0] (a name: key) is also exclude[0]"]);
    const both = parsePeopleConfig({ bots: ["login:robot"], humans: ["login:Robot"] });
    expect(both.problems).toEqual(["bots[0] (a login: key) is also humans[0]"]);
    expect(twice.problems.join("")).not.toContain("x@example.com");
  });

  it("refuses two entries with one id", () => {
    const result = parsePeopleConfig({
      people: [
        { id: "ada", match: ["name:a"] },
        { id: "ada", match: ["name:b"] },
      ],
    });
    expect(result.problems).toEqual(["people[1].id: people[1] sets the id people[0] sets"]);
  });
});
