import { type Manifest, PeopleConfig, type PersonRevision } from "@repowiki/core";
import { makePersonRevision } from "@repowiki/core/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { personRevisionProblems } from "./check.ts";
import { readPeople } from "./refresh.ts";
import { type TeamFixture, teamFixture } from "./test-people.ts";

let fx: TeamFixture;
beforeAll(async () => {
  fx = await teamFixture();
});
afterAll(() => fx.remove());

const commit = (sha: string, subject: string) => ({
  kind: "commit" as const,
  sha,
  subject,
  pr: null,
});
const claim = (
  id: string,
  text: string,
  citations: ReturnType<typeof commit>[],
  supports: string[] = [],
) => ({
  id,
  text,
  kind: citations.length === 0 ? ("fact" as const) : ("history" as const),
  citations,
  supports,
  staleSince: null,
  hook: false,
});

/** Ada's narrative, citing `cited` in its one chronicle claim. */
const revision = (
  cited: string,
  text = "In January 2026, signal ingestion was started.",
): PersonRevision =>
  makePersonRevision({
    id: `person-ada-lovelace-${fx.feb.slice(0, 12)}-1`,
    sha: fx.feb,
    basis: fx.feb,
    sections: [
      {
        key: "lead",
        claims: [claim("c1", "**Ada Lovelace** contributed to [[signals]].", [], ["c2"])],
      },
      { key: "chronicle", claims: [claim("c2", text, [commit(cited, "feat: start signals")])] },
    ],
  });

const check = (
  revisions: PersonRevision[],
  routing: Partial<{ latest: Manifest; pages: Set<string> }> = {},
) =>
  personRevisionProblems({
    read: readPeople({
      repo: fx.repo.dir,
      sha: fx.feb,
      store: fx.store,
      config: PeopleConfig.parse({}),
      ownerEmail: null,
    }),
    snapshot: fx.refreshed.snapshot,
    revisions,
    manifests: [fx.manifest],
    manifestAt: () => fx.manifest,
    latest: routing.latest ?? fx.manifest,
    pages: routing.pages ?? new Set(),
  });

describe("personRevisionProblems' link routing (the Task 28 ruling)", () => {
  it("flags a link valid when written that no longer leads to a page, as v1's pages are judged", () => {
    const where = `person ada-lovelace (person-ada-lovelace-${fx.feb.slice(0, 12)}-1)`;
    const retired = {
      ...fx.manifest,
      features: fx.manifest.features.map((f) =>
        f.id === "signals" ? { ...f, status: { kind: "retired" as const, sha: fx.feb } } : f,
      ),
    } as Manifest;
    expect(check([revision(fx.jan)], { latest: retired })).toEqual([
      `${where}: c1: a link to signals no longer leads to a page`,
    ]);
    // A retired feature that kept its stored page still routes.
    expect(check([revision(fx.jan)], { latest: retired, pages: new Set(["signals"]) })).toEqual([]);
    const dropped = { ...fx.manifest, features: fx.manifest.features.slice(1) } as Manifest;
    expect(check([revision(fx.jan)], { latest: dropped })).toEqual([
      `${where}: c1: a link to signals no longer leads to a page`,
    ]);
  });
});

describe("personRevisionProblems (spec v2 #6 §9)", () => {
  it("passes a narrative citing the person's own commit", () => {
    expect(check([revision(fx.jan)])).toEqual([]);
  });

  it("flags a citation of another person's commit, a wrong date and a link to nowhere", () => {
    const where = `person ada-lovelace (person-ada-lovelace-${fx.feb.slice(0, 12)}-1): c2:`;
    expect(check([revision(fx.b1)])).toEqual([
      `${where} citation 1 is not one of this person's commits the pack shows; cite only those`,
    ]);
    expect(check([revision(fx.jan, "In March 2026, [[nowhere]] was started.")])).toEqual([
      `${where} the claim states a date outside its cited commits' dates 2026-01-02 to 2026-01-02`,
      `${where} links to nowhere: [[nowhere]]`,
    ]);
  });

  it("accepts the landing of a pull request the person merged, and skips people without a page", () => {
    expect(check([revision(fx.pr6, "On 7 January 2026, a crud fix was merged.")])).toEqual([]);
    const gone = {
      ...revision(fx.jan),
      personId: "nobody",
      id: `person-nobody-${fx.feb.slice(0, 12)}-1`,
    };
    expect(check([gone])).toEqual([]);
  });
});
