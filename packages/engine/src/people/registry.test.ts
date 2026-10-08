import { PeopleConfig, type RegistryRow } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import type { AuthoredCommit } from "../index/index.ts";
import { StoreError } from "../store/index.ts";
import { resolveIdentities } from "./identities.ts";
import { parseMailmap } from "./mailmap.ts";
import { assignIds } from "./registry.ts";

let n = 0;
function by(name: string, email: string, day: number): AuthoredCommit {
  n++;
  const date = `2026-02-${String(day).padStart(2, "0")}T12:00:00Z`;
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

const groupsOf = (commits: AuthoredCommit[], file: unknown = {}) =>
  resolveIdentities({
    commits,
    mailmap: parseMailmap(""),
    config: PeopleConfig.parse(file),
    salt: "7".repeat(64),
    ownerEmail: null,
  }).groups;

/** Runs assignIds and returns the ids by display name, plus the rest. */
function assign(commits: AuthoredCommit[], stored: RegistryRow[] = [], file: unknown = {}) {
  const groups = groupsOf(commits, file);
  const result = assignIds(groups, stored);
  return { ...result, byName: Object.fromEntries(groups.map((g, i) => [g.name, result.ids[i]])) };
}

describe("assignIds and excluded people (the final review's M1)", () => {
  it("gives a new excluded person a private id, so a visible id never shows they exist", () => {
    const { ids } = assign([by("Alex Smith", "a1@e.com", 1), by("Alex Smith", "a2@e.com", 2)], [], {
      exclude: ["email:a1@e.com"],
      people: [{ match: ["email:a2@e.com"] }],
    });
    expect(ids).toEqual(["excluded-1", "alex-smith"]);
  });

  it("gives a person whose exclusion is lifted a normal id, the private one gone (round 2)", () => {
    const commits = [by("Kim Hidden", "kim@e.com", 1), by("Ada Lovelace", "ada@e.com", 2)];
    const first = assign(commits, [], { exclude: ["email:kim@e.com"] });
    expect(first.ids).toEqual(["excluded-1", "ada-lovelace"]);
    const lifted = assign(commits, first.registry);
    expect(lifted.ids).toEqual(["kim-hidden", "ada-lovelace"]);
    expect(lifted.redirects).toEqual([]);
    expect(lifted.registry.map((r) => r.id)).toEqual(["kim-hidden", "ada-lovelace"]);
    expect(lifted.registry[0]?.order).toBe(first.registry[0]?.order);
  });
});

describe("assignIds (spec v2 #6 R13)", () => {
  it("makes ids from display names, accents stripped, collisions numbered by first commit", () => {
    const { ids, registry } = assign([
      by("Zoë Ångström", "z@e.com", 1),
      by("Ada Lovelace", "a1@e.com", 2),
      by("ada lovelace!", "a2@e.com", 3),
      by("株式会社", "k@e.com", 4),
    ]);
    // "ada lovelace!" is not "Ada Lovelace" by name, but slugs the same.
    expect(ids).toEqual(["zoe-angstrom", "ada-lovelace", "ada-lovelace-2", "person-1"]);
    expect(registry.map((r) => [r.id, r.order, r.status])).toEqual([
      ["zoe-angstrom", 0, "active"],
      ["ada-lovelace", 1, "active"],
      ["ada-lovelace-2", 2, "active"],
      ["person-1", 3, "active"],
    ]);
  });

  it("numbers a second person whose name slugs the same", () => {
    const { ids } = assign([by("Sam Lee", "s1@e.com", 1), by("Sam  Lee", "s2@e.com", 2)], [], {
      people: [{ match: ["email:s2@e.com"] }],
    });
    expect(ids).toEqual(["sam-lee", "sam-lee-2"]);
  });

  it("keeps an id once published, through a rename", () => {
    const first = assign([by("ada", "a@e.com", 1)]);
    const again = assign(
      [by("ada", "a@e.com", 1), by("Ada Lovelace", "a@e.com", 2)],
      first.registry,
    );
    expect(again.ids).toEqual(["ada"]);
    expect(again.registry[0]?.name).toBe("Ada Lovelace");
    expect(again.regrouped.size).toBe(0);
  });

  it("merges two stored people into the larger one, leaving a redirect", () => {
    const commits = [
      by("Wyatt Brown", "w@e.com", 1),
      by("wyattb", "wb@e.com", 2),
      by("wyattb", "wb@e.com", 3),
    ];
    const before = assign(commits);
    expect(before.ids).toEqual(["wyatt-brown", "wyattb"]);
    const after = assign(commits, before.registry, {
      people: [{ match: ["email:w@e.com", "email:wb@e.com"] }],
    });
    expect(after.ids).toEqual(["wyattb"]);
    expect(after.redirects).toEqual([{ from: "wyatt-brown", to: "wyattb" }]);
    expect(after.regrouped).toEqual(new Set(["wyattb"]));
  });

  it("keeps a split person's id with the side that has more of their commits", () => {
    const commits = [
      by("Sam Lee", "a@e.com", 1),
      by("Sam Lee", "b@e.com", 2),
      by("Sam Lee", "b@e.com", 3),
    ];
    const before = assign(commits);
    expect(before.ids).toEqual(["sam-lee"]);
    const after = assign(commits, before.registry, { people: [{ match: ["email:a@e.com"] }] });
    expect(after.ids).toEqual(["sam-lee-2", "sam-lee"]);
    expect(after.regrouped).toEqual(new Set(["sam-lee"]));
    expect(after.redirects).toEqual([]);
  });

  it("takes a people-file id and leaves a redirect, flattening older ones", () => {
    const commits = [by("Ada", "a@e.com", 1)];
    const first = assign(commits);
    const second = assign(commits, first.registry, {
      people: [{ id: "countess", match: ["name:ada"] }],
    });
    expect(second.ids).toEqual(["countess"]);
    const third = assign(commits, second.registry, {
      people: [{ id: "ada-l", match: ["name:ada"] }],
    });
    expect(third.ids).toEqual(["ada-l"]);
    expect(third.redirects).toEqual([
      { from: "ada", to: "ada-l" },
      { from: "countess", to: "ada-l" },
    ]);
  });

  it("refuses a people-file id another person holds", () => {
    const commits = [by("Ada", "a@e.com", 1), by("Bo", "b@e.com", 2)];
    const first = assign(commits);
    expect(() =>
      assign(commits, first.registry, { people: [{ id: "ada", match: ["name:bo"] }] }),
    ).toThrow(StoreError);
  });

  it("keeps an excluded person's row private, with no redirect to them", () => {
    const commits = [by("Ada", "a@e.com", 1), by("ada2", "a2@e.com", 2)];
    const merged = assign(commits, [], {
      people: [{ id: "ada", match: ["name:ada", "name:ada2"] }],
    });
    const before = assign(commits);
    const excluded = assign(commits, before.registry, {
      people: [{ match: ["name:ada", "name:ada2"] }],
      exclude: ["email:a2@e.com"],
    });
    expect(merged.redirects).toEqual([]);
    expect(excluded.registry.find((r) => r.id === "ada")?.status).toBe("excluded");
    expect(excluded.redirects).toEqual([]);
  });

  it("keeps a stored row no group matches any more", () => {
    const orphan: RegistryRow = {
      id: "gone",
      order: 0,
      name: "Gone",
      kind: "human",
      status: "active",
      to: null,
      keys: ["9".repeat(64)],
    };
    const { registry } = assign([by("Ada", "a@e.com", 1)], [orphan]);
    expect(registry.map((r) => [r.id, r.order])).toEqual([
      ["gone", 0],
      ["ada", 1],
    ]);
  });

  it("is deterministic", () => {
    const commits = [by("Ada", "a@e.com", 1), by("Bo", "b@e.com", 2)];
    expect(assign(commits)).toEqual(assign(commits));
  });

  it("keeps two people who share a name key on their own ids, run after run", () => {
    const johns = [by("john", "j1@e.com", 1), by("john", "j2@e.com", 2), by("john", "j2@e.com", 3)];
    const sams = [
      by("Sam Lee", "a@e.com", 1),
      by("Sam Lee", "b@e.com", 2),
      by("Sam Lee", "b@e.com", 3),
    ];
    const fence = { people: [{ match: ["email:b@e.com"] }] };
    for (const [commits, file] of [
      [johns, {}],
      [sams, fence],
    ] as const) {
      const first = assign([...commits], [], file);
      let stored = first.registry;
      for (let run = 2; run <= 3; run++) {
        const next = assign([...commits], stored, file);
        expect(next.ids, `run ${run}`).toEqual(first.ids);
        expect(next.redirects).toEqual([]);
        expect(next.regrouped.size).toBe(0);
        expect(next.registry).toEqual(first.registry);
        stored = next.registry;
      }
    }
  });

  it("gives a stored row to the group sharing its email before one sharing only its name", () => {
    const first = assign([by("Kim Ng", "k1@e.com", 1)]);
    // Kim's name now belongs to a busier stranger too, fenced apart; Kim keeps her id.
    const commits = [
      by("Kim Ng", "k1@e.com", 1),
      by("Kim Ng", "k2@e.com", 2),
      by("Kim Ng", "k2@e.com", 3),
      by("Kim Ng", "k2@e.com", 4),
    ];
    const next = assign(commits, first.registry, { people: [{ match: ["email:k2@e.com"] }] });
    expect(next.ids).toEqual(["kim-ng", "kim-ng-2"]);
    expect(next.redirects).toEqual([]);
  });

  it("never counts a shared placeholder address as a strong key (as T10's joins)", () => {
    const first = assign([by("Pat Doe", "noreply@github.com", 1)]);
    // Pat's row holds the shared placeholder; a busier stranger now commits with it.
    const commits = [
      by("Pat Doe", "pat@e.com", 1),
      by("Zed Roe", "noreply@github.com", 2),
      by("Zed Roe", "noreply@github.com", 3),
    ];
    const next = assign(commits, first.registry);
    expect(next.ids).toEqual(["pat-doe", "zed-roe"]);
    expect(next.redirects).toEqual([]);
  });

  it("refuses a people-file id an unmatched stored row or a retired id holds", () => {
    const orphan: RegistryRow = {
      id: "gone",
      order: 0,
      name: "Gone",
      kind: "human",
      status: "active",
      to: null,
      keys: ["9".repeat(64)],
    };
    expect(() =>
      assign([by("Ada", "a@e.com", 1)], [orphan], {
        people: [{ id: "gone", match: ["name:ada"] }],
      }),
    ).toThrow(/the id gone is already/);
    const commits = [by("Ada", "a@e.com", 1), by("Bo", "b@e.com", 2)];
    const renamed = assign(commits, assign(commits).registry, {
      people: [{ id: "countess", match: ["name:ada"] }],
    });
    // "ada" is now a retired id, redirecting to Ada's: Bo may not take it...
    expect(() =>
      assign(commits, renamed.registry, {
        people: [
          { id: "countess", match: ["name:ada"] },
          { id: "ada", match: ["name:bo"] },
        ],
      }),
    ).toThrow(StoreError);
    // ...but Ada may take it back.
    const back = assign(commits, renamed.registry, {
      people: [{ id: "ada", match: ["name:ada"] }],
    });
    expect(back.ids).toEqual(["ada", "bo"]);
    expect(back.redirects).toEqual([{ from: "countess", to: "ada" }]);
  });
});
