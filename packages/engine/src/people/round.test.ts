import { PeopleConfig } from "@repowiki/core";
import { makePersonRevision } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparePeople, storeNarratives } from "./round.ts";
import { type TeamFixture, teamFixture } from "./test-people.ts";
import type { PersonOutcome } from "./write.ts";

let fx: TeamFixture;
beforeEach(async () => {
  fx = await teamFixture();
});
afterEach(() => fx.remove());

const CONSENT = { people: [{ match: ["name:ada lovelace"], narrative: true }] };
const prepare = (file: unknown, narrative = true) =>
  preparePeople({
    repo: fx.repo.dir,
    sha: fx.feb,
    store: fx.store,
    config: PeopleConfig.parse(file),
    ownerEmail: null,
    manifest: fx.manifest,
    narrative,
    only: null,
  });

describe("preparePeople (spec v2 #6 §4, §9)", () => {
  it("refreshes, then requests each due narrative", async () => {
    const prepared = await prepare(CONSENT);
    expect(fx.store.getPeopleSnapshot()?.sha).toBe(fx.feb);
    expect(prepared.requests.map((r) => [r.personId, r.append])).toEqual([["ada-lovelace", false]]);
    expect((await prepare(CONSENT, false)).requests).toEqual([]);
  });

  it("deletes a narrative whose consent was withdrawn", async () => {
    fx.store.putPersonRevision(
      makePersonRevision({
        sha: fx.feb,
        basis: fx.feb,
        id: `person-ada-lovelace-${fx.feb.slice(0, 12)}-1`,
      }),
    );
    const prepared = await prepare({});
    expect(prepared.revoked).toBe(1);
    expect(fx.store.getCurrentPersonRevision("ada-lovelace")).toBeNull();
  });
});

describe("storeNarratives", () => {
  it("stores the written narratives and flushes the journal in the same transaction", () => {
    const revision = makePersonRevision({
      sha: fx.feb,
      id: `person-ada-lovelace-${fx.feb.slice(0, 12)}-1`,
    });
    const outcome = (r: typeof revision | null) =>
      ({ personId: "ada-lovelace", revision: r }) as PersonOutcome;
    let flushed = 0;
    const journal = { flush: () => void flushed++ } as Parameters<typeof storeNarratives>[2];
    expect(storeNarratives(fx.store, [outcome(revision), outcome(null)], journal)).toBe(1);
    expect(fx.store.getCurrentPersonRevision("ada-lovelace")?.id).toBe(revision.id);
    expect(flushed).toBe(1);
    // A refused revision (a stale parent) still flushes, then throws.
    expect(() => storeNarratives(fx.store, [outcome(revision)], journal)).toThrow();
    expect(flushed).toBe(2);
  });
});
