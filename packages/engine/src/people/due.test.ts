import { PeopleConfig, type PersonRevision } from "@repowiki/core";
import { makePersonRevision } from "@repowiki/core/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planNarratives } from "./due.ts";
import { refreshPeople } from "./refresh.ts";
import { type TeamFixture, teamFixture } from "./test-people.ts";

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
