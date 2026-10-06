import { type Manifest, PeopleConfig } from "@repowiki/core";
import { makeFeature } from "@repowiki/core/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, readAuthorship, type TestRepo } from "../index/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { resolveIdentities } from "./identities.ts";
import { parseMailmap } from "./mailmap.ts";
import { blameTree } from "./ownership.ts";
import { assignIds } from "./registry.ts";
import { computeSnapshot, topologicalNewestFirst } from "./snapshot.ts";

const ADA = { name: "Ada Lovelace", email: "ada@example.com" };
const BOB = { name: "Bob Smith", email: "bob@example.com" };
const KIM = { name: "Kim Private", email: "kim@example.com" };
const BOT = { name: "dependabot[bot]", email: "1+dependabot[bot]@users.noreply.github.com" };

let repo: TestRepo;
let store: Store;
beforeEach(() => {
  repo = createTestRepo();
  store = openStore(":memory:");
});
afterEach(() => {
  store.close();
  repo.remove();
});

/** The fixture: two features, a renamed file, a deleted one, a lockfile, a sweep and two PRs. */
function history() {
  repo.write("src/signals/ingest.py", "a = 1\nb = 2\n");
  repo.write("src/old/legacy.py", "legacy = 1\n");
  const first = repo.commit("feat: ingest", "+0100", ADA);
  repo.git("switch", "-q", "-c", "topic");
  repo.git("mv", "src/signals/ingest.py", "src/signals/intake.py");
  repo.write("src/signals/intake.py", "a = 1\nb = 2\nc = 3\n");
  const moved = repo.commit("refactor: rename ingest", "-0500", BOB);
  repo.git("switch", "-q", "main");
  const merge = repo.merge(
    "topic",
    "Merge pull request #3 from bob/topic\n\nRename the ingest module",
    ADA,
  );
  repo.git("rm", "-q", "src/old/legacy.py");
  repo.write("src/deliverables/crud.py", "x = 1\n");
  repo.write("pnpm-lock.yaml", "lock\n".repeat(40));
  const squash = repo.commit("feat: deliverables (#5)", "+0000", BOB);
  repo.write("src/deliverables/crud.py", "x = 2\ny = 3\n");
  const hidden = repo.commit("fix: crud", "+0000", KIM);
  repo.write("pnpm-lock.yaml", "lock 2\n");
  const bump = repo.commit("chore: bump", "+0000", BOT);
  for (let i = 0; i < 4; i++) repo.write(`src/deliverables/f${i}.py`, `v = ${i}\n`);
  const sweep = repo.commit("style: sweep", "+0000", ADA);
  return { first, moved, merge, squash, hidden, bump, sweep, head: sweep };
}

function manifests(head: string, old: string): Manifest[] {
  const features = [
    makeFeature({
      id: "signals",
      title: "Signals",
      aliases: [],
      lineage: [{ kind: "create", sha: old }],
    }),
    makeFeature({
      id: "deliverables",
      title: "Deliverables",
      aliases: [],
      lineage: [{ kind: "create", sha: old }],
    }),
    makeFeature({
      id: "legacy",
      title: "Legacy",
      aliases: [],
      status: { kind: "redirect", to: "deliverables" },
      lineage: [
        { kind: "create", sha: old },
        { kind: "merge", sha: head, into: "deliverables" },
      ],
    }),
  ];
  return [
    {
      sha: head,
      features,
      membership: {
        "src/signals/intake.py": { featureId: "signals", weight: 1 },
        "src/deliverables/crud.py": { featureId: "deliverables", weight: 1 },
      },
    },
    {
      sha: old,
      features: features.map((f) =>
        f.id === "legacy"
          ? {
              ...f,
              status: { kind: "active" as const },
              lineage: [{ kind: "create" as const, sha: old }],
            }
          : f,
      ),
      membership: { "src/old/legacy.py": { featureId: "legacy", weight: 1 } },
    },
  ];
}

async function compute(file: unknown = {}, shuffle = false) {
  const fx = history();
  const config = PeopleConfig.parse(file);
  const commits = readAuthorship(repo.dir, fx.head);
  const identities = resolveIdentities({
    commits,
    mailmap: parseMailmap(""),
    config,
    salt: "3".repeat(64),
    ownerEmail: null,
  });
  const assigned = assignIds(identities.groups, []);
  const ownership = await blameTree(repo.dir, fx.head, store, { ignoreRevs: [] });
  const computed = computeSnapshot({
    sha: fx.head,
    commits: shuffle ? [...commits].reverse() : commits,
    identities,
    ids: assigned.ids,
    redirects: assigned.redirects,
    ownership,
    manifests: manifests(fx.head, fx.first),
    config,
    maxFilesPerCommit: 3,
  });
  return { fx, ...computed };
}

describe("computeSnapshot (spec v2 #6 §7)", () => {
  it("counts activity by the author's calendar day, with R20's line rules", async () => {
    const { snapshot } = await compute();
    const ada = snapshot.people.find((p) => p.id === "ada-lovelace");
    expect(ada?.activity).toEqual([
      { day: "2026-01-02", commits: 1, added: 3, deleted: 0 },
      { day: "2026-01-08", commits: 1, added: 0, deleted: 0 },
    ]);
    expect([ada?.commits, ada?.added, ada?.deleted]).toEqual([2, 3, 0]);
    const bob = snapshot.people.find((p) => p.id === "bob-smith");
    expect(bob?.activity.map((d) => d.day)).toEqual(["2026-01-02", "2026-01-05"]);
    expect([bob?.added, bob?.deleted]).toEqual([2, 1]);
    expect(snapshot.commits).toBe(6);
  });

  it("maps commits to features through renames, older manifests and redirects (R19)", async () => {
    const { snapshot, commitFeatures, fx } = await compute();
    expect(commitFeatures.get(fx.first)).toEqual(["deliverables", "signals"]);
    expect(commitFeatures.get(fx.moved)).toEqual(["signals"]);
    expect(commitFeatures.get(fx.sweep)).toEqual([]);
    expect(commitFeatures.has(fx.merge)).toBe(false);
    const ada = snapshot.people.find((p) => p.id === "ada-lovelace");
    expect(ada?.features.map((f) => [f.featureId, f.commits])).toEqual([
      ["signals", 1],
      ["deliverables", 1],
    ]);
  });

  it("gives each person their current lines, and excluded people's lines to no one", async () => {
    const { snapshot } = await compute({ exclude: ["name:Kim Private"] });
    const lines = Object.fromEntries(snapshot.people.map((p) => [p.id, p.currentLines]));
    expect(lines).toEqual({
      "ada-lovelace": 6,
      "bob-smith": 1,
      "dependabot-bot": 0,
    });
    expect(snapshot.featureLines).toEqual({ deliverables: 2, signals: 3 });
    expect([snapshot.totalLines, snapshot.unattributedLines]).toEqual([9, 2]);
    expect(snapshot.people.map((p) => p.id)).not.toContain("kim-private");
    expect(snapshot.others).toEqual([{ day: "2026-01-06", commits: 1, added: 2, deleted: 1 }]);
    expect(JSON.stringify(snapshot)).not.toContain("Kim");
  });

  it("folds an excluded person's activity into nothing below othersMinPeople", async () => {
    const { snapshot } = await compute({ exclude: ["name:Kim Private"], othersMinPeople: 2 });
    expect(snapshot.others).toEqual([]);
    expect(snapshot.commits).toBe(6);
  });

  it("credits a pull request to the author of most of its commits, and a merge to its merger (R6)", async () => {
    const { snapshot } = await compute();
    const bob = snapshot.people.find((p) => p.id === "bob-smith");
    expect(bob?.prsAuthored).toEqual([
      { number: 3, title: "Rename the ingest module", mergedAt: "2026-01-04T00:00:00Z" },
      { number: 5, title: "feat: deliverables", mergedAt: "2026-01-05T00:00:00Z" },
    ]);
    expect(bob?.prsMerged).toEqual([]);
    expect(snapshot.people.find((p) => p.id === "ada-lovelace")?.prsMerged).toEqual([3]);
  });

  it("lists the bot with its counts", async () => {
    const { snapshot } = await compute();
    expect(snapshot.people.find((p) => p.id === "dependabot-bot")).toMatchObject({
      kind: "bot",
      commits: 1,
      added: 0,
    });
  });

  it("is byte-identical across runs and across the order the log arrives in", async () => {
    const a = await compute();
    const json = JSON.stringify(a.snapshot);
    store.clearBlameCache();
    repo.remove();
    repo = createTestRepo();
    const b = await compute({}, true);
    // The fixture is rebuilt, so shas differ only if the dates or authors do: they do not.
    expect(JSON.stringify(b.snapshot)).toBe(json);
  });
});

describe("topologicalNewestFirst", () => {
  it("puts every commit after its children, whatever order they come in", () => {
    const fx = history();
    const commits = readAuthorship(repo.dir, fx.head);
    const order = topologicalNewestFirst([...commits].reverse()).map((c) => c.sha);
    expect(order).toEqual(topologicalNewestFirst(commits).map((c) => c.sha));
    for (const c of commits)
      for (const p of c.parents) expect(order.indexOf(p)).toBeGreaterThan(order.indexOf(c.sha));
  });
});
