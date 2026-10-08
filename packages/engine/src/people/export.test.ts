import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PeopleConfig, WikiExport } from "@repowiki/core";
import {
  makeInFlight,
  makeInFlightIssue,
  makeInFlightPull,
  makePersonRevision,
} from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configuredEmail } from "../index/index.ts";
import { buildExport, writeExport } from "../store/index.ts";
import { refreshPeople } from "./refresh.ts";
import { PEOPLE_SECRETS, type PeopleFixture, peopleFixture } from "./test-people.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let fx: PeopleFixture;
beforeEach(async () => {
  fx = await peopleFixture();
});
afterEach(() => fx.remove());

const refresh = (file: unknown = {}) =>
  refreshPeople({
    repo: fx.repo.dir,
    sha: fx.head,
    store: fx.store,
    config: PeopleConfig.parse(file),
    ownerEmail: configuredEmail(fx.repo.dir),
    lock: null,
  });
const options = { repo: "demo", exportedAt: "2026-10-06T12:00:00Z" };

describe("buildExport's People (spec v2 #6 §5, R28)", () => {
  it("is null until People runs, then carries the snapshot and the current narratives", async () => {
    expect(buildExport(fx.store, options).people).toBeNull();
    await refresh();
    fx.store.putPersonRevision(
      makePersonRevision({ sha: fx.head, id: `person-ada-lovelace-${fx.head.slice(0, 12)}-1` }),
    );
    const people = buildExport(fx.store, options).people;
    expect(people?.snapshot).toEqual(fx.store.getPeopleSnapshot());
    expect(people?.pages.map((p) => p.personId)).toEqual(["ada-lovelace"]);
  });

  it("leaves out the narrative of a person no longer in the snapshot", async () => {
    await refresh();
    fx.store.putPersonRevision(
      makePersonRevision({
        personId: "kim-hidden",
        sha: fx.head,
        id: `person-kim-hidden-${fx.head.slice(0, 12)}-1`,
      }),
    );
    expect(buildExport(fx.store, options).people?.pages).toHaveLength(1);
    await refresh({ exclude: ["name:Kim Hidden"] });
    expect(buildExport(fx.store, options).people?.pages).toEqual([]);
  });

  it("is null when the snapshot names a feature the manifest lacks", async () => {
    const { snapshot } = await refresh();
    fx.store.putPeopleSnapshot({
      ...snapshot,
      featureLines: { ...snapshot.featureLines, zzz: 0 },
    });
    expect(buildExport(fx.store, options).people).toBeNull();
  });
});

describe("the export's privacy (spec v2 #6 §13)", () => {
  it("writes no author email, local part, salt or salted key to export.json or llms.txt, and nothing of an excluded person", async () => {
    await refresh({ exclude: ["name:Kim Hidden"] });
    // A stored narrative, so the pages half of the export is scanned too.
    fx.store.putPersonRevision(
      makePersonRevision({ sha: fx.head, id: `person-ada-lovelace-${fx.head.slice(0, 12)}-1` }),
    );
    const path = join(fx.out, "export.json");
    writeExport(fx.store, path, options);
    const json = readFileSync(path, "utf8");
    const llms = readFileSync(join(fx.out, "llms.txt"), "utf8");
    expect(WikiExport.parse(JSON.parse(json)).people?.snapshot.people.length).toBeGreaterThan(0);
    expect(llms).toContain("(people/ada-lovelace/)");
    expect(WikiExport.parse(JSON.parse(json)).people?.pages).toHaveLength(1);
    // Neither the store's salt nor any salted key of the registry leaves the store (R10).
    const hashes = [
      fx.store.getPeopleSalt(),
      ...fx.store.listPeopleRegistry().flatMap((row) => row.keys),
    ];
    expect(hashes.length).toBeGreaterThan(1);
    for (const text of [json, llms]) {
      for (const secret of [...PEOPLE_SECRETS, ...hashes]) expect(text).not.toContain(secret);
      expect(text).not.toContain("Kim Hidden");
      expect(text).not.toContain("kim-hidden");
    }
  });
});

describe("work in flight's authors (spec v2 #6 C8)", () => {
  const inflight = () =>
    makeInFlight({
      pulls: [
        makeInFlightPull({ author: { login: "bob-q7login", bot: false, person: null } }),
        makeInFlightPull({
          number: 13,
          closes: [],
          author: { login: "dependabot", bot: true, person: null },
        }),
      ],
      issues: [makeInFlightIssue({ author: { login: "stranger", bot: false, person: null } })],
    });

  it("links a login that resolves to a person, and leaves a bot and a stranger as they are", async () => {
    fx.store.putInFlight(inflight());
    expect(buildExport(fx.store, options).inflight?.pulls[0]?.author?.person).toBeNull();
    await refresh();
    const joined = buildExport(fx.store, options).inflight;
    expect(joined?.pulls.map((p) => p.author)).toEqual([
      { login: "bob-q7login", bot: false, person: "bob" },
      { login: "dependabot", bot: true, person: null },
    ]);
    expect(joined?.issues[0]?.author).toEqual({ login: "stranger", bot: false, person: null });
  });

  it("exports an excluded person's pull request with no author", async () => {
    fx.store.putInFlight(inflight());
    await refresh({ exclude: ["login:bob-q7login"] });
    const exported = buildExport(fx.store, options);
    expect(exported.inflight?.pulls[0]?.author).toBeNull();
    expect(JSON.stringify(exported)).not.toContain("bob-q7login");
  });
});
