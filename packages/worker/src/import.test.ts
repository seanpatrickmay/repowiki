import { WikiExport } from "@repowiki/core";
import { makePeopleSnapshot } from "@repowiki/core/test-fixtures";
import { Facts } from "@repowiki/hosted";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { exportFacts, matchAuthor } from "./import.ts";

const ADA = { login: "ada", name: "Ada Lovelace" };
const peopleExport = () =>
  WikiExport.parse({
    ...fixtureExport(),
    repo: "engine",
    people: { snapshot: makePeopleSnapshot({ sha: fixtureExport().head }), pages: [] },
  });

describe("exportFacts", () => {
  it("takes languages and size from the page infoboxes and the author's share from People", () => {
    const facts = exportFacts(peopleExport(), ADA);
    expect(Facts.parse(facts)).toEqual(facts);
    expect(facts.indexedFiles).toBe(15);
    expect(facts.languages).toEqual([
      { name: "Python", share: 0.731 },
      { name: "TypeScript", share: 0.268 },
    ]);
    expect(facts.author).toEqual({
      commits: 4,
      totalCommits: 9,
      currentLines: 90,
      totalLines: 240,
      features: [
        { featureId: "signals", commits: 3, currentLines: 80 },
        { featureId: "deliverables", commits: 1, currentLines: 10 },
      ],
    });
  });

  it("gives zeros when People does not name the author, or there is no People", () => {
    const zeros = { commits: 0, currentLines: 0, features: [] };
    expect(exportFacts(peopleExport(), { login: "nobody", name: null }).author).toMatchObject({
      ...zeros,
      totalCommits: 9,
    });
    expect(exportFacts(WikiExport.parse(fixtureExport()), ADA).author).toMatchObject(zeros);
  });
});

describe("matchAuthor", () => {
  const snapshot = makePeopleSnapshot();
  it("matches the login, the display name or another name, ignoring case and spacing", () => {
    for (const author of [
      { login: "ADA", name: null },
      { login: "someone", name: "ada lovelace" },
      { login: "ada-lovelace", name: null },
      { login: "x", name: "Grace  Hopper" },
    ]) {
      expect(matchAuthor(snapshot, author)?.kind, JSON.stringify(author)).toBe("human");
    }
    expect(matchAuthor(snapshot, { login: "x", name: "Grace Hopper" })?.id).toBe("grace-hopper");
  });

  it("never takes a bot's numbers or guesses between two people", () => {
    expect(matchAuthor(snapshot, { login: "dependabot", name: null })).toBeNull();
    expect(matchAuthor(snapshot, { login: "ada", name: "Grace Hopper" })?.id).toBe("ada-lovelace");
    expect(matchAuthor(snapshot, { login: "zed", name: "Grace Hopper" })?.id).toBe("grace-hopper");
    const twins = makePeopleSnapshot({
      people: snapshot.people.map((p) => (p.id === "grace-hopper" ? { ...p, name: "Ada" } : p)),
    });
    expect(matchAuthor(twins, { login: "zed", name: "Ada" })).toBeNull();
  });
});
