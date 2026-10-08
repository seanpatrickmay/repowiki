import { PeopleConfig } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import type { AuthoredCommit } from "../index/index.ts";
import {
  noreplyLogin,
  type ResolvedIdentities,
  resolveIdentities,
  saltedKey,
} from "./identities.ts";
import { parseMailmap } from "./mailmap.ts";

const SALT = "5".repeat(64);
let n = 0;

/** A commit by `name <email>` on day `day` of 2026 (merges when `parents` is 2). */
function by(name: string, email: string, day = 1, parents = 1): AuthoredCommit {
  n++;
  const date = `2026-01-${String(day).padStart(2, "0")}T12:00:00+00:00`;
  return {
    sha: n.toString(16).padStart(40, "0"),
    parents: Array.from({ length: parents }, (_, i) => `${i}`.repeat(40)),
    authorName: name,
    authorEmail: email,
    authorDate: date,
    commitDate: date,
    subject: `commit ${n}`,
    mergeTitle: null,
    files: [],
    pr: null,
  };
}

const resolve = (
  commits: AuthoredCommit[],
  file: unknown = {},
  options: { mailmap?: string; ownerEmail?: string | null } = {},
): ResolvedIdentities =>
  resolveIdentities({
    commits,
    mailmap: parseMailmap(options.mailmap ?? ""),
    config: PeopleConfig.parse(file),
    salt: SALT,
    ownerEmail: options.ownerEmail ?? null,
  });

const names = (resolved: ResolvedIdentities) => resolved.groups.map((g) => g.name);

/**
 * A synthetic table with the shape spec v2 #6 §2 states for next-chief-of-staff (planner ruling
 * R13): 15 distinct pairs, which the automatic rules make 8 humans and 1 bot, with one handle
 * (`wyattb`) that only a people-file entry joins to its full name.
 */
const TEAM = [
  by("Sean May", "1+seanpatrickmay@users.noreply.github.com", 1),
  by("seanpatrickmay", "sean@personal.example", 2),
  by("Sean May", "sean@school.example", 3),
  by("wyattb", "wyatt.b@example.com", 4),
  by("Wyatt Brown", "wbrown@uni.example", 5),
  by("Priya Patel", "priya@uni.example", 6),
  by("priya patel", "2+ppatel@users.noreply.github.com", 7),
  by("Priya Patel", "PRIYA@uni.example", 8),
  by("Diego Ramos", "diego@uni.example", 9),
  by("Diego Ramos", "diego.ramos@mail.example", 10),
  by("Mei Chen", "mei@uni.example", 11),
  by("Mei Chen", "4+meichen@users.noreply.github.com", 12),
  by("Alex Kim", "alex@uni.example", 13),
  by("jordan", "jordan@uni.example", 14),
  by("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com", 15),
];

describe("noreplyLogin", () => {
  it("reads both noreply forms, a bot's included", () => {
    expect(noreplyLogin("1+Octo@users.noreply.github.com")).toBe("octo");
    expect(noreplyLogin("octo@users.noreply.github.com")).toBe("octo");
    expect(noreplyLogin("4+dependabot[bot]@users.noreply.github.com")).toBe("dependabot[bot]");
    expect(noreplyLogin("octo@example.com")).toBeNull();
  });
});

describe("resolveIdentities (spec v2 #6 §6, R7)", () => {
  it("groups the synthetic team into 8 humans and 1 bot, with no false merge", () => {
    const resolved = resolve(TEAM);
    expect(resolved.groups.map((g) => [g.name, g.kind, g.identities.length])).toEqual([
      ["Sean May", "human", 3],
      ["wyattb", "human", 1],
      ["Wyatt Brown", "human", 1],
      ["Priya Patel", "human", 3],
      ["Diego Ramos", "human", 2],
      ["Mei Chen", "human", 2],
      ["Alex Kim", "human", 1],
      ["jordan", "human", 1],
      ["dependabot[bot]", "bot", 1],
    ]);
    expect(resolved.groups[0]?.reasons).toEqual(["name is login", "same full name"]);
    expect(resolved.groups[3]?.reasons).toEqual(["same email", "same full name"]);
  });

  it("joins the handle with one people-file entry, giving 7 humans", () => {
    const resolved = resolve(TEAM, {
      people: [{ name: "Wyatt Brown", match: ["name:wyattb", "email:wbrown@uni.example"] }],
    });
    expect(resolved.groups.filter((g) => g.kind === "human")).toHaveLength(7);
    const wyatt = resolved.groups.find((g) => g.name === "Wyatt Brown");
    expect(wyatt?.identities.map((i) => i.name)).toEqual(["wyattb", "Wyatt Brown"]);
    expect(wyatt?.entry).toBe(0);
    expect(wyatt?.otherNames).toEqual(["wyattb"]);
  });

  it("joins on each automatic rule alone", () => {
    const pairs = (commits: AuthoredCommit[]) => resolve(commits).groups.length;
    expect(pairs([by("A", "x@e.com"), by("B", "X@E.com")])).toBe(1);
    expect(
      pairs([by("A", "1+octo@users.noreply.github.com"), by("B", "octo@users.noreply.github.com")]),
    ).toBe(1);
    expect(pairs([by("octo", "a@e.com"), by("Octo Cat", "9+octo@users.noreply.github.com")])).toBe(
      1,
    );
    expect(pairs([by("Ada  Lovelace", "a@e.com"), by("ada lovelace", "b@e.com")])).toBe(1);
    expect(pairs([by("ada", "a@e.com"), by("Ada", "b@e.com")])).toBe(2);
  });

  it("applies the committed mailmap before grouping", () => {
    const resolved = resolve(
      [by("A", "old@e.com"), by("Ada L", "ada@e.com")],
      {},
      {
        mailmap: "Ada Lovelace <ada@e.com> <old@e.com>\n",
      },
    );
    expect(names(resolved)).toEqual(["Ada Lovelace"]);
    // "A" is the name the mailmap replaced: it never leaves the store (the I1 ruling).
    expect(resolved.groups[0]?.otherNames).toEqual(["Ada L"]);
  });

  it("never shows a name the mailmap replaced: not as an other name, nor as a shown name (I1)", () => {
    const resolved = resolve(
      [by("Old Deadname", "ada@e.com", 1), by("Ada Lovelace", "ada@e.com", 2)],
      {},
      { mailmap: "Ada Lovelace <ada@e.com>\n" },
    );
    const [ada] = resolved.groups;
    expect(ada?.name).toBe("Ada Lovelace");
    expect(ada?.otherNames).toEqual([]);
    expect(ada?.identities.map((p) => p.shownName)).toEqual(["Ada Lovelace", "Ada Lovelace"]);
    expect(ada?.replacedNames).toEqual(["Old Deadname"]);
  });

  it("takes first and last dates from dated commits only, unless none is (the I3 ruling)", () => {
    const undated = (c: AuthoredCommit): AuthoredCommit => ({
      ...c,
      authorDate: "2026-03-01T00:00:00+00:00",
      undated: true,
    });
    const both = resolve([by("Ada", "ada@e.com", 5), undated(by("Ada", "ada@e.com", 1))]);
    expect([both.groups[0]?.firstCommit, both.groups[0]?.lastCommit]).toEqual([
      "2026-01-05T12:00:00+00:00",
      "2026-01-05T12:00:00+00:00",
    ]);
    const only = resolve([undated(by("Bob", "bob@e.com", 1))]);
    expect(only.groups[0]?.firstCommit).toBe("2026-03-01T00:00:00+00:00");
  });

  it("fences an explicit group from the automatic rules, so a group splits a wrong merge", () => {
    const commits = [by("Sam Lee", "sam@a.com", 1), by("Sam Lee", "sam@b.com", 2)];
    expect(resolve(commits).groups).toHaveLength(1);
    const split = resolve(commits, { people: [{ match: ["email:sam@b.com"] }] });
    expect(split.groups.map((g) => g.identities.map((i) => i.email))).toEqual([
      ["sam@a.com"],
      ["sam@b.com"],
    ]);
  });

  it("excludes a whole group when any of its identities is excluded", () => {
    const resolved = resolve([by("Kim Park", "kim@a.com"), by("Kim Park", "kim@b.com")], {
      exclude: ["email:kim@b.com"],
    });
    expect(resolved.groups.map((g) => [g.identities.length, g.excluded])).toEqual([[2, true]]);
  });

  it("detects bots by suffix and the fixed list, and lets the file override both ways", () => {
    const commits = [
      by("renovate", "r@e.com", 1),
      by("release-runner", "rr@e.com", 2),
      by("ci[bot]", "ci@e.com", 3),
      by("Codecov", "cc@e.com", 4),
    ];
    expect(resolve(commits).groups.map((g) => g.kind)).toEqual(["bot", "human", "bot", "bot"]);
    const overridden = resolve(commits, {
      bots: ["name:release-runner"],
      humans: ["name:codecov"],
    });
    expect(overridden.groups.map((g) => g.kind)).toEqual(["bot", "bot", "bot", "human"]);
  });

  it("names a person by R14's order: the file, the mailmap, two or more words, the most used", () => {
    const commits = [
      by("ada", "a@e.com", 1),
      by("ada", "a@e.com", 2),
      by("Ada Lovelace", "a@e.com", 3),
    ];
    expect(names(resolve(commits))).toEqual(["Ada Lovelace"]);
    expect(names(resolve(commits, {}, { mailmap: "Countess <a@e.com>\n" }))).toEqual(["Countess"]);
    expect(
      names(resolve(commits, { people: [{ name: "A. L.", match: ["email:a@e.com"] }] })),
    ).toEqual(["A. L."]);
    expect(names(resolve([by("ada", "a@e.com", 1), by("Ada", "a@e.com", 2)]))).toEqual(["ada"]);
  });

  it("cleans hostile names, and calls a name that cleans to nothing Contributor <n>", () => {
    const resolved = resolve([
      by("\u202E\u200B", "a@e.com", 1),
      by("Evil\u202E [[x]] **y**\u0085", "b@e.com", 2),
      by("me@private.example", "c@e.com", 3),
    ]);
    expect(names(resolved)).toEqual(["Contributor 1", "Evil [[x]] **y**", "Contributor 2"]);
  });

  it("never shows a derived login as an other name", () => {
    const resolved = resolve([
      by("Octo Cat", "1+octocat@users.noreply.github.com"),
      by("octocat", "o@e.com"),
    ]);
    expect(resolved.groups[0]?.name).toBe("Octo Cat");
    expect(resolved.groups[0]?.otherNames).toEqual([]);
    expect(resolved.groups[0]?.logins).toEqual(["octocat"]);
  });

  it("finds the owner by the configured email, or by the file's owner keys", () => {
    expect(
      resolve(TEAM, {}, { ownerEmail: "SEAN@school.example" }).groups.map((g) => g.owner),
    ).toEqual([true, ...Array(8).fill(false)]);
    const byFile = resolve(TEAM, { owner: ["name:jordan"] }, { ownerEmail: "sean@school.example" });
    expect(byFile.groups.filter((g) => g.owner).map((g) => g.name)).toEqual(["jordan"]);
    expect(resolve(TEAM).groups.some((g) => g.owner)).toBe(false);
  });

  it("carries the file's id and narrative flag, and salts every key", () => {
    const resolved = resolve([by("Ada", "a@e.com")], {
      people: [{ id: "ada-l", narrative: true, match: ["email:a@e.com", "login:adal"] }],
    });
    const [ada] = resolved.groups;
    expect([ada?.id, ada?.narrative]).toEqual(["ada-l", true]);
    expect(ada?.keys).toContain(saltedKey(SALT, "email:a@e.com"));
    expect(ada?.keys).toContain(saltedKey(SALT, "login:adal"));
    expect(JSON.stringify(ada?.keys)).not.toContain("a@e.com");
  });

  it("counts non-merge commits, spans merges too, and maps each pair to its group", () => {
    const resolved = resolve([
      by("Ada", "a@e.com", 1),
      by("Ada", "a@e.com", 5, 2),
      by("Bo", "b@e.com", 3),
    ]);
    expect(
      resolved.groups.map((g) => [
        g.name,
        g.commits,
        g.firstCommit.slice(0, 10),
        g.lastCommit.slice(0, 10),
      ]),
    ).toEqual([
      ["Ada", 1, "2026-01-01", "2026-01-05"],
      ["Bo", 1, "2026-01-03", "2026-01-03"],
    ]);
    expect(resolved.groupOf("Bo", "b@e.com")).toBe(1);
    expect(resolved.groupOf("Bo", "x@e.com")).toBe(-1);
  });

  it("warns of keys that match nobody and authors two entries claim, naming no email", () => {
    const resolved = resolve([by("Ada", "a@e.com")], {
      people: [{ match: ["name:ada"] }, { match: ["email:a@e.com"] }],
      exclude: ["email:ghost@e.com"],
    });
    expect(resolved.warnings).toEqual([
      "people file: an email: key matches no author",
      "people file: one author matches people[0] and people[1]; people[0] takes it",
    ]);
  });

  it("gives the same groups whatever order the commits come in", () => {
    const shuffled = [...TEAM].reverse();
    expect(resolve(shuffled).groups).toEqual(resolve(TEAM).groups);
  });

  it("lets no fenced identity hold a key for joining: the rest still join among themselves", () => {
    const emails = (resolved: ResolvedIdentities) =>
      resolved.groups.map((g) => g.identities.map((i) => i.email));
    const sams = [by("Sam Lee", "sam@b.com", 1), by("Sam Lee", "sam@a.com", 2)];
    expect(
      emails(
        resolve([...sams, by("Sam Lee", "sam@c.com", 3)], {
          people: [{ match: ["email:sam@b.com"] }],
        }),
      ),
    ).toEqual([["sam@b.com"], ["sam@a.com", "sam@c.com"]]);
    const shared = [by("Alice", "x@e.com", 1), by("Bob", "x@e.com", 2), by("Bob B", "X@e.com", 3)];
    expect(
      resolve(shared, { people: [{ match: ["name:alice"] }] }).groups.map(
        (g) => g.identities.length,
      ),
    ).toEqual([1, 2]);
    const octos = [
      by("Octo One", "1+octo@users.noreply.github.com", 1),
      by("X", "2+octo@users.noreply.github.com", 2),
      by("Y", "octo@users.noreply.github.com", 3),
    ];
    expect(
      resolve(octos, { people: [{ match: ["name:octo one"] }] }).groups.map(
        (g) => g.identities.length,
      ),
    ).toEqual([1, 2]);
  });

  it("gives a join reason only between two distinct identities", () => {
    expect(resolve([by("Sam Lee", "s@e.com")]).groups[0]?.reasons).toEqual([]);
    expect(resolve([by("GitHub Actions", "g@e.com")]).groups[0]?.reasons).toEqual([]);
    const team = resolve(TEAM).groups;
    expect(team.find((g) => g.name === "Wyatt Brown")?.reasons).toEqual([]);
    expect(team.find((g) => g.name === "Alex Kim")?.reasons).toEqual([]);
  });

  it("never joins strangers by a shared placeholder address", () => {
    for (const email of [
      "noreply@github.com",
      "noreply@users.noreply.github.com",
      "no-reply@example.org",
      "NoReply@Example.com",
    ]) {
      const resolved = resolve([by("Ann One", email, 1), by("Ben Two", email, 2)]);
      expect(resolved.groups, email).toHaveLength(2);
      expect(resolved.groups[0]?.logins, email).toEqual([]);
    }
    // A real address still joins.
    expect(resolve([by("Ann One", "a@e.com", 1), by("Ben Two", "a@e.com", 2)]).groups).toHaveLength(
      1,
    );
  });

  it("makes a group a bot only when every identity in it looks like one", () => {
    const mixed = resolve([by("Ada Lovelace", "a@e.com", 1), by("dependabot", "a@e.com", 2)]);
    expect(mixed.groups.map((g) => [g.kind, g.partlyBot])).toEqual([["human", true]]);
    const bots = resolve([by("dependabot[bot]", "b@e.com", 1), by("renovate", "b@e.com", 2)]);
    expect(bots.groups.map((g) => [g.kind, g.partlyBot])).toEqual([["bot", false]]);
    // The people file's bots: key still makes a whole group a bot.
    const listed = resolve([by("Ada Lovelace", "a@e.com", 1), by("Runner", "a@e.com", 2)], {
      bots: ["name:runner"],
    });
    expect(listed.groups[0]?.kind).toBe("bot");
  });

  it("orders groups and their dates totally, whatever the commits' order and time zones", () => {
    const commits = [
      by("Sam Lee", "a@e.com", 1),
      { ...by("Sam Lee", "a@e.com", 1), authorDate: "2026-01-01T13:00:00+01:00" },
      by("Sam Lee", "b@e.com", 1),
    ];
    const file = { people: [{ match: ["email:a@e.com"] }, { match: ["email:b@e.com"] }] };
    const forward = resolve(commits, file).groups;
    const backward = resolve([...commits].reverse(), file).groups;
    expect(backward).toEqual(forward);
    expect(forward.map((g) => g.firstCommit)).toEqual([
      "2026-01-01T12:00:00+00:00",
      "2026-01-01T12:00:00+00:00",
    ]);
  });

  it("passes every warning through withoutEmails", () => {
    const resolved = resolve([by("Ada", "a@e.com")], {
      exclude: ["name:kim@hidden.example"],
      humans: ["name:kim\uFF20hidden.example"],
    });
    expect(resolved.warnings).toEqual([
      "people file: name:[email] matches no author",
      "people file: name:[email] matches no author",
    ]);
  });
});
