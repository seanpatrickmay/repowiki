import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PeopleConfig } from "@repowiki/core";
import { buildJournal, configuredEmail, refreshPeople } from "@repowiki/engine";
import { chronicleProvider, type PeopleFixture, peopleFixture } from "@repowiki/engine/test-people";
import { DEFAULT_MODELS } from "@repowiki/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peopleAfterUpdate } from "./people-hook.ts";
import { parseReplayArgs, parseUpdateArgs } from "./update-cli.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let fx: PeopleFixture;
let key: string | undefined;
beforeEach(async () => {
  fx = await peopleFixture();
  key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
  fx.remove();
});

const turnOn = () =>
  refreshPeople({
    repo: fx.repo.dir,
    sha: fx.head,
    store: fx.store,
    config: PeopleConfig.parse({}),
    ownerEmail: configuredEmail(fx.repo.dir),
  });
const hook = (extra: Partial<Parameters<typeof peopleAfterUpdate>[0]> = {}) =>
  peopleAfterUpdate({
    repo: fx.repo.dir,
    out: fx.out,
    repoName: "demo",
    store: fx.store,
    models: DEFAULT_MODELS,
    log: () => {},
    command: "wiki:update",
    batch: true,
    maxUsd: 0.5,
    ...extra,
  });

describe("peopleAfterUpdate (spec v2 #6 §9, R24)", () => {
  it("does nothing while People is off", async () => {
    expect(await hook()).toEqual([]);
    expect(fx.store.getPeopleSnapshot()).toBeNull();
  });

  it("refreshes with no call and leaves the narratives due when there is no key", async () => {
    await turnOn();
    const lines = await hook();
    expect(lines.join("\n")).toContain(
      "1 not written (ANTHROPIC_API_KEY is not set; they stay due)",
    );
    expect(fx.store.getCurrentPersonRevision("ada-lovelace")).toBeNull();
  });

  it("writes the due narratives in one round under the ceiling", async () => {
    await turnOn();
    const llm = chronicleProvider();
    const lines = await hook({
      connect: () => ({ provider: llm.provider, journal: buildJournal(fx.store) }),
    });
    expect(llm.requests).toHaveLength(1);
    expect(lines.join("\n")).toContain(
      "Narratives: 1 written, 0 appended, 0 carried, 0 failed, 0 over the $0.50 ceiling.",
    );
    expect(fx.store.getCurrentPersonRevision("ada-lovelace")).not.toBeNull();
  });

  it("warns and never fails the update when the people file is broken", async () => {
    await turnOn();
    writeFileSync(join(fx.out, "people.json"), "{ nope");
    const lines = await hook();
    expect(lines).toEqual([
      "## People",
      "",
      expect.stringMatching(/^Not refreshed: .*is not a JSON people file$/),
      "",
    ]);
  });
});

describe("--people-max-usd", () => {
  it("defaults to $0.50 and parses as --max-usd does, for update and replay", () => {
    expect(parseUpdateArgs(["r", "HEAD"]).peopleMaxUsd).toBe(0.5);
    expect(parseUpdateArgs(["r", "HEAD", "--people-max-usd", "2"]).peopleMaxUsd).toBe(2);
    expect(parseReplayArgs(["r", "a", "b", "--people-max-usd", "0.1"]).peopleMaxUsd).toBe(0.1);
    expect(() => parseUpdateArgs(["r", "HEAD", "--people-max-usd", "1e3"])).toThrow(
      /--people-max-usd must be/,
    );
  });
});
