import { PeopleConfig, type PersonRevision } from "@repowiki/core";
import { makePersonRevision } from "@repowiki/core/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRepo } from "../index/index.ts";
import { openStore } from "../store/index.ts";
import { planNarratives } from "./due.ts";
import { refreshPeople } from "./refresh.ts";
import { type TeamFixture, teamFixture } from "./test-people.ts";
import { personRequest } from "./write.ts";

let fx: TeamFixture;
beforeAll(async () => {
  fx = await teamFixture();
});
afterAll(() => fx.remove());

/** Ada and Kim consent; Bob does not. */
const CONSENT = {
  people: [
    { match: ["name:ada lovelace"], narrative: true },
    { match: ["name:kim filler"], narrative: true },
  ],
};
const refresh = (file: unknown) =>
  refreshPeople({
    repo: fx.repo.dir,
    sha: fx.feb,
    store: fx.store,
    config: PeopleConfig.parse(file),
    ownerEmail: null,
    lock: null,
  });
const revision = (personId: string, basis: string): PersonRevision =>
  makePersonRevision({ personId, basis, id: `person-${personId}-${fx.feb.slice(0, 12)}-1` });

describe("planNarratives (spec v2 #6 R15, R25)", () => {
  it("is off for everyone without consent, and due for those who gave it, by rank", async () => {
    const none = await refresh({});
    expect(planNarratives(none, new Map(), PeopleConfig.parse({})).due).toEqual([]);
    const refreshed = await refresh(CONSENT);
    const plan = planNarratives(refreshed, new Map(), PeopleConfig.parse(CONSENT));
    // Kim's 30 commits rank above Ada's 4.
    expect(plan.due.map((d) => [d.personId, d.reason, d.append])).toEqual([
      ["kim-filler", "missing", false],
      ["ada-lovelace", "missing", false],
    ]);
  });

  it("carries a narrative whose basis reaches all the person's commits, and appends a newer one", async () => {
    const refreshed = await refresh(CONSENT);
    const config = PeopleConfig.parse(CONSENT);
    const current = new Map([
      ["ada-lovelace", revision("ada-lovelace", fx.pr6)],
      ["kim-filler", revision("kim-filler", fx.feb)],
    ]);
    const plan = planNarratives(refreshed, current, config);
    expect(plan.carried).toEqual(["kim-filler"]);
    expect(plan.due).toMatchObject([{ personId: "ada-lovelace", reason: "newer", append: true }]);
  });

  it("writes a narrative whole when its basis left the history, and honours --only and the cap", async () => {
    const refreshed = await refresh(CONSENT);
    const current = new Map([["ada-lovelace", revision("ada-lovelace", "f".repeat(40))]]);
    const config = PeopleConfig.parse(CONSENT);
    expect(planNarratives(refreshed, current, config).due[1]).toMatchObject({
      personId: "ada-lovelace",
      reason: "regrouped",
      append: false,
    });
    const only = planNarratives(refreshed, new Map(), config, new Set(["ada-lovelace"]));
    expect([only.due.map((d) => d.personId), only.skipped]).toEqual([
      ["ada-lovelace"],
      ["kim-filler"],
    ]);
    const capped = planNarratives(
      refreshed,
      new Map(),
      PeopleConfig.parse({ ...CONSENT, maxNarratives: 1 }),
    );
    expect([capped.due.map((d) => d.personId), capped.overCap]).toEqual([
      ["kim-filler"],
      ["ada-lovelace"],
    ]);
  });

  it("revokes a stored narrative whose consent was withdrawn, but not an excluded person's", async () => {
    const withdrawn = { people: [{ match: ["name:ada lovelace"], narrative: false }] };
    const current = new Map([["ada-lovelace", revision("ada-lovelace", fx.feb)]]);
    const plan = planNarratives(await refresh(withdrawn), current, PeopleConfig.parse(withdrawn));
    expect(plan.revoked).toEqual(["ada-lovelace"]);
    const excluded = { exclude: ["name:ada lovelace"] };
    expect(
      planNarratives(await refresh(excluded), current, PeopleConfig.parse(excluded)).revoked,
    ).toEqual([]);
  });
});

describe("planNarratives across runs (the Task 21 ruling)", () => {
  it("settles after one append when the person's commits sit on sibling branches", async () => {
    const repo = createTestRepo();
    const store = openStore(":memory:");
    try {
      const ada = { name: "Ada Lovelace", email: "ada.q7private@example.com" };
      const bob = { name: "Bob Smith", email: "bob@example.com" };
      repo.write("src/signals/ingest.py", "a = 1\n");
      const base = repo.commit("feat: start", "+0000", ada);
      repo.git("switch", "-q", "-c", "b1");
      repo.write("src/signals/x.py", "x = 1\n");
      repo.commit("feat: x", "+0000", ada);
      repo.git("switch", "-q", "main");
      repo.git("switch", "-q", "-c", "b2");
      repo.write("src/signals/y.py", "y = 1\n");
      repo.commit("feat: y", "+0000", ada);
      repo.git("switch", "-q", "main");
      repo.merge("b1", "Merge pull request #1 from ada/b1\n\nX", bob);
      const head = repo.merge("b2", "Merge pull request #2 from ada/b2\n\nY", bob);
      const manifest = {
        ...fx.manifest,
        sha: head,
        features: fx.manifest.features.map((f) => ({
          ...f,
          lineage: [{ kind: "create" as const, sha: base }],
        })),
        membership: {
          "src/signals/ingest.py": { featureId: "signals", weight: 1 },
          "src/signals/x.py": { featureId: "signals", weight: 1 },
          "src/signals/y.py": { featureId: "signals", weight: 1 },
        },
      };
      store.putManifest(manifest);
      store.setHead(head);
      const config = PeopleConfig.parse({
        people: [{ match: ["name:ada lovelace"], narrative: true }],
      });
      const refreshed = await refreshPeople({
        repo: repo.dir,
        sha: head,
        store,
        config,
        ownerEmail: null,
        lock: null,
      });
      const request = personRequest(refreshed, "ada-lovelace", manifest, {
        parent: null,
        append: false,
      });
      // The basis is the head the round ran at, so it reaches both branches' commits.
      expect(request?.pack.basis).toBe(head);
      const written = makePersonRevision({
        id: `person-ada-lovelace-${head.slice(0, 12)}-1`,
        basis: request?.pack.basis ?? "",
        groupFingerprint: request?.fingerprint ?? null,
      });
      const plan = planNarratives(refreshed, new Map([["ada-lovelace", written]]), config);
      expect(plan.carried).toEqual(["ada-lovelace"]);
      expect(plan.due).toEqual([]);
    } finally {
      store.close();
      repo.remove();
    }
  });

  it("keeps a split person's narrative due, run after run, until it is rewritten", async () => {
    const store = openStore(":memory:");
    try {
      store.putManifest(fx.manifest);
      store.setHead(fx.feb);
      const merged = {
        people: [
          { id: "ada-lovelace", match: ["name:ada lovelace", "name:bob smith"], narrative: true },
        ],
      };
      const run = (file: unknown) =>
        refreshPeople({
          repo: fx.repo.dir,
          sha: fx.feb,
          store,
          config: PeopleConfig.parse(file),
          ownerEmail: null,
          lock: null,
        });
      const together = await run(merged);
      const request = personRequest(together, "ada-lovelace", fx.manifest, {
        parent: null,
        append: false,
      });
      const written = makePersonRevision({
        id: `person-ada-lovelace-${fx.feb.slice(0, 12)}-1`,
        basis: fx.feb,
        groupFingerprint: request?.fingerprint ?? null,
      });
      const current = new Map([["ada-lovelace", written]]);
      // Carried while the group stays the same...
      expect(
        planNarratives(await run(merged), current, PeopleConfig.parse(merged)).carried,
      ).toEqual(["ada-lovelace"]);
      // ...then split apart, and still due on the next run, with nothing written in between.
      const split = {
        people: [{ id: "ada-lovelace", match: ["name:ada lovelace"], narrative: true }],
      };
      for (let i = 0; i < 2; i++) {
        const plan = planNarratives(await run(split), current, PeopleConfig.parse(split));
        expect(plan.due, `run ${i + 1}`).toMatchObject([
          { personId: "ada-lovelace", reason: "regrouped", append: false },
        ]);
      }
      // A revision stored before the fingerprint existed is never called regrouped by it.
      const old = new Map([["ada-lovelace", { ...written, groupFingerprint: null }]]);
      expect(planNarratives(await run(split), old, PeopleConfig.parse(split)).carried).toEqual([
        "ada-lovelace",
      ]);
    } finally {
      store.close();
    }
  });
});
