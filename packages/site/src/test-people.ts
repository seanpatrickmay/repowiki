import { type PeopleExport, WikiExport } from "@repowiki/core";
import {
  makePeopleSnapshot,
  makePersonFacts,
  makePersonRevision,
} from "@repowiki/core/test-fixtures";
import { fixtureExport } from "./test-fixtures.ts";

/** A person name GitHub and git would both accept: markup, quotes and an ampersand. */
export const HOSTILE_PERSON_NAME = "<script>alert(1)</script> \"Q\" & 'P'";

/**
 * People on the site's fixture wiki (spec v2 #6 §13): Ada Lovelace with her narrative, Grace
 * Hopper with none, a hostile-named person, the dependabot bot, and Ada's old id `ada`
 * redirecting to her page. One person was excluded: only the anonymous series is theirs.
 * Test-only.
 */
export function fixturePeople(): PeopleExport {
  const snapshot = makePeopleSnapshot();
  const hostile = makePersonFacts({
    id: "hostile-name",
    name: HOSTILE_PERSON_NAME,
    otherNames: [],
    commits: 1,
    currentLines: 0,
    added: 1,
    deleted: 0,
    prsAuthored: [],
    prsMerged: [],
    features: [{ featureId: "deliverables", commits: 1, currentLines: 0 }],
    firstCommit: "2025-12-30T10:00:00Z",
    lastCommit: "2025-12-30T10:00:00Z",
    activity: [{ day: "2025-12-30", commits: 1, added: 1, deleted: 0 }],
  });
  return {
    snapshot: {
      ...snapshot,
      commits: snapshot.commits + 1,
      people: [...snapshot.people, hostile].sort((a, b) => (a.id < b.id ? -1 : 1)),
    },
    pages: [makePersonRevision()],
  };
}

/** The fixture export with People on. Test-only. */
export function peopleExport(): WikiExport {
  return WikiExport.parse({ ...fixtureExport(), people: fixturePeople() });
}
