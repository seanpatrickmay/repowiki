import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { featureLinkTargets, PersonRevision } from "@repowiki/core";
import {
  cassetteFetch,
  cassetteMode,
  createClaudeProvider,
  createLedger,
  DEFAULT_MODELS,
} from "@repowiki/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TeamFixture, teamFixture } from "./test-people.ts";
import { type PersonRequest, personRequest, writePeople } from "./write.ts";

const mode = cassetteMode();
const cassette = (name: string) =>
  fileURLToPath(new URL(`./__cassettes__/${name}.json`, import.meta.url));
/** Two live calls and maybe a retry each, unbatched; a replay is instant. */
const TIMEOUT_MS = mode === "record" ? 300_000 : undefined;
const now = () => new Date("2026-10-06T12:00:00Z");

let fx: TeamFixture;
beforeAll(async () => {
  fx = await teamFixture();
});
afterAll(() => fx.remove());

/** One unbatched round on the cassette `name`, and the ledger it wrote. */
async function round(name: string, request: PersonRequest) {
  const ledger = createLedger();
  const provider = createClaudeProvider({
    models: DEFAULT_MODELS,
    ledger,
    runId: "test-run",
    run: { kind: "people", sha: fx.feb },
    apiKey: mode === "record" ? undefined : "cassette-replay",
    fetch: cassetteFetch(cassette(name), mode),
    now,
  });
  const [outcome] = await writePeople(
    {
      requests: [request],
      manifest: fx.manifest,
      sha: fx.feb,
      commitDate: "2026-02-07T01:00:00+01:00",
    },
    { provider, repoName: "team", batch: false, now },
  );
  if (outcome === undefined) throw new Error("one outcome per request");
  return { outcome, entries: ledger.entries() };
}

/** Every invariant a recorded narrative must keep (spec v2 #6 §8.4, R17, R10). */
function expectSound(revision: PersonRevision, request: PersonRequest) {
  expect(PersonRevision.parse(revision)).toEqual(revision);
  expect(revision.sections[0]?.key).toBe("lead");
  expect(revision.sections[0]?.claims[0]?.text.startsWith("**Ada Lovelace**")).toBe(true);
  for (const claim of revision.sections.flatMap((s) => s.claims))
    for (const c of claim.citations)
      expect(c.kind === "commit" && (request.pack.shas.has(c.sha) || request.parent !== null)).toBe(
        true,
      );
  expect(JSON.stringify(revision)).not.toMatch(/q7pack|@example\.com/);
  // The Task 18 and Task 22 rulings: at most 30 chronicle claims, none told twice.
  const chronicle = revision.sections.find((s) => s.key === "chronicle")?.claims ?? [];
  expect(chronicle.length).toBeLessThanOrEqual(30);
  const told = chronicle.map((c) => c.text.replace(/\s+/g, " ").trim().toLowerCase());
  expect(new Set(told).size).toBe(told.length);
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The months a revision's chronicle claims state: each month name with the year after it. */
function chronicleMonths(revision: PersonRevision): Set<string> {
  const months = new Set<string>();
  for (const claim of revision.sections.find((s) => s.key === "chronicle")?.claims ?? []) {
    const named = [...claim.text.matchAll(new RegExp(`\\b(${MONTHS.join("|")})\\b`, "g"))];
    for (const m of named) {
      const year = claim.text.slice(m.index).match(/\b(\d{4})\b/)?.[1];
      if (year !== undefined) months.add(`${year}-${MONTHS.indexOf(m[1] ?? "")}`);
    }
  }
  return months;
}

/** Every month from `first` to `last` (UTC), as chronicleMonths names them. */
function activeMonths(first: string, last: string): string[] {
  const out: string[] = [];
  const end = new Date(last);
  for (let d = new Date(first); ; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1))) {
    out.push(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);
    if (d.getUTCFullYear() === end.getUTCFullYear() && d.getUTCMonth() === end.getUTCMonth())
      return out;
  }
}

/** The features a revision's areas claims link. */
const areasOf = (revision: PersonRevision) =>
  (revision.sections.find((s) => s.key === "areas")?.claims ?? []).flatMap((c) =>
    featureLinkTargets(c.text).slice(0, 1),
  );

describe("writePeople with Claude (cassette)", () => {
  it(
    "writes Ada's narrative, then appends to it, from the recordings",
    async () => {
      const first = personRequest(fx.refreshed, "ada-lovelace", fx.manifest, {
        parent: null,
        append: false,
      });
      if (first === null) throw new Error("Ada has a request");
      const built = await round("team-people", first);
      // The replay is deterministic, so the narrative is written.
      expect(built.outcome.failure).toBeNull();
      const revision = built.outcome.revision as PersonRevision;
      expectSound(revision, first);
      expect(revision.reason).toBe("build");
      // The chronicle covers the whole span, not just the newest work (#616).
      const ada = fx.refreshed.snapshot.people.find((p) => p.id === "ada-lovelace");
      const active = activeMonths(ada?.firstCommit ?? "", ada?.lastCommit ?? "");
      const told = chronicleMonths(revision);
      expect(active.filter((m) => told.has(m)).length).toBeGreaterThanOrEqual(0.8 * active.length);

      // An append whose stored narrative stops at the PR #6 merge: only February is new.
      const parent = { ...revision, basis: fx.pr6 };
      const next = personRequest(fx.refreshed, "ada-lovelace", fx.manifest, {
        parent,
        append: true,
      });
      if (next === null) throw new Error("Ada has a request");
      const appended = await round("team-people-append", next);
      expect(appended.outcome.failure).toBeNull();
      const update = appended.outcome.revision as PersonRevision;
      expectSound(update, next);
      expect(update).toMatchObject({ reason: "update", parentId: revision.id });
      const kept = revision.sections.find((s) => s.key === "chronicle")?.claims.map((c) => c.text);
      const now = update.sections.find((s) => s.key === "chronicle")?.claims.map((c) => c.text);
      expect(now?.slice(0, kept?.length)).toEqual(kept);
      // The append's areas still cover every feature the parent's did (the Task 22 ruling).
      expect(new Set(areasOf(update))).toEqual(new Set(areasOf(revision)));

      for (const e of [...built.entries, ...appended.entries]) {
        expect(e).toMatchObject({
          purpose: "people",
          batch: false,
          cacheKey: null,
          featureId: null,
          runKind: "people",
          sha: fx.feb,
        });
        expect(e.model.startsWith("claude-haiku-4-5")).toBe(true);
      }
      // The recordings hold the packs, never an author's address (R10).
      for (const name of ["team-people", "team-people-append"])
        if (existsSync(cassette(name)))
          expect(readFileSync(cassette(name), "utf8")).not.toMatch(
            /q7pack|bob@example\.com|kim@example\.com/,
          );
    },
    TIMEOUT_MS,
  );
});
