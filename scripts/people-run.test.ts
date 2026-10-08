import { PeopleConfig } from "@repowiki/core";
import { buildJournal, configuredEmail } from "@repowiki/engine";
import {
  chronicleProvider,
  PEOPLE_SECRETS,
  type PeopleFixture,
  peopleFixture,
} from "@repowiki/engine/test-people";
import { DEFAULT_MODELS } from "@repowiki/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPeopleStep } from "./people-run.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let fx: PeopleFixture;
beforeEach(async () => {
  fx = await peopleFixture();
});
afterEach(() => fx.remove());

const step = (overrides: Partial<Parameters<typeof runPeopleStep>[0]> = {}) => {
  const llm = chronicleProvider();
  const log: string[] = [];
  const run = runPeopleStep({
    repo: fx.repo.dir,
    repoName: "demo",
    store: fx.store,
    config: PeopleConfig.parse({}),
    ownerEmail: configuredEmail(fx.repo.dir),
    lock: null,
    narrative: true,
    only: null,
    rebuildBlame: false,
    models: DEFAULT_MODELS,
    batch: true,
    maxUsd: 1,
    dryRun: false,
    connect: () => ({ provider: llm.provider, journal: buildJournal(fx.store) }),
    log: (line) => log.push(line),
    ...overrides,
  });
  return run.then((result) => ({ result, requests: llm.requests, log }));
};

describe("runPeopleStep (spec v2 #6 §9, §10)", () => {
  it("writes the owner's narrative only, and gives everyone a row", async () => {
    const { result, requests, log } = await step();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.content).toMatch(/^# Person: Ada Lovelace/);
    expect(fx.store.getCurrentPersonRevision("ada-lovelace")?.reason).toBe("build");
    const rows = Object.fromEntries(result.rows.map((r) => [r.id, r.narrative]));
    expect(rows).toMatchObject({
      "ada-lovelace": "written",
      bob: "none (fewer than 3 commits)",
      "dependabot-bot": "none (bot)",
    });
    expect(log[0]).toMatch(
      /^1 narrative due; 1 within the \$1\.0000 ceiling, estimated at most \$0\.0\d+ \(batched\)$/,
    );
    // One row per person of the snapshot, no more and no fewer.
    expect(result.rows.map((r) => r.id)).toEqual(
      result.prepared.refreshed.snapshot.people.map((p) => p.id),
    );
  });

  it("carries the narrative on a second run, with no call", async () => {
    await step();
    const { result, requests } = await step();
    expect(requests).toHaveLength(0);
    expect(result.rows.find((r) => r.id === "ada-lovelace")?.narrative).toBe("carried");
  });

  it("sends nothing for a dry run, --no-narrative or a ceiling too low, and says so", async () => {
    const dry = await step({ dryRun: true });
    expect(dry.requests).toHaveLength(0);
    expect(dry.result.rows.find((r) => r.id === "ada-lovelace")?.narrative).toBe("due (missing)");
    const facts = await step({ narrative: false });
    expect(facts.requests).toHaveLength(0);
    expect(facts.result.rows.find((r) => r.id === "ada-lovelace")?.narrative).toBe(
      "skipped (--no-narrative)",
    );
    expect(facts.log[0]).toBe("narratives skipped (--no-narrative)");
    const poor = await step({ maxUsd: 0.0001 });
    expect(poor.log[0]).toMatch(/^1 narrative due; 0 within the \$0\.0001 ceiling/);
    expect(poor.requests).toHaveLength(0);
    expect(poor.result.rows.find((r) => r.id === "ada-lovelace")?.narrative).toBe(
      "over budget; due next run",
    );
    expect(fx.store.getCurrentPersonRevision("ada-lovelace")).toBeNull();
  });

  it("takes three consenting people in rank order while the next fits the ceiling", async () => {
    const config = PeopleConfig.parse({
      minCommits: 1,
      people: [
        { match: ["name:bob"], narrative: true },
        { match: ["name:kim hidden"], narrative: true },
      ],
    });
    const all = await step({ config, dryRun: true });
    expect(all.result.taken.map((r) => r.personId)).toEqual(["ada-lovelace", "bob", "kim-hidden"]);
    const two = await step({ config, maxUsd: all.result.estimateUsd - 1e-9 });
    expect(
      two.requests.map((r) => /^# Person: (.+)$/m.exec(r.messages[0]?.content ?? "")?.[1]),
    ).toEqual(["Ada Lovelace", "bob"]);
    expect(two.result.rows.find((r) => r.id === "kim-hidden")?.narrative).toBe(
      "over budget; due next run",
    );
    expect(two.log[0]).toMatch(/^3 narratives due; 2 within the/);
  });

  it("prints no author address or local part, in its rows, notes, log or requests", async () => {
    const { result, requests, log } = await step({
      config: PeopleConfig.parse({ exclude: ["name:Kim Hidden"] }),
    });
    const printed = JSON.stringify([
      result.rows,
      result.notes,
      log,
      requests.map((r) => r.messages),
    ]);
    for (const secret of PEOPLE_SECRETS) expect(printed).not.toContain(secret);
    expect(printed).not.toContain("Kim");
  });

  it("notes an exclusion and its caveat, naming no one", async () => {
    const { result } = await step({ config: PeopleConfig.parse({ exclude: ["name:Kim Hidden"] }) });
    expect(result.notes.join(" ")).toContain("1 person is excluded");
    expect(result.notes.join(" ")).not.toContain("Kim");
    expect(result.rows.map((r) => r.id)).not.toContain("kim-hidden");
  });
});
