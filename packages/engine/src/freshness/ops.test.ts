import { Manifest } from "@repowiki/core";
import { makeFeature, makeManifest, SHA_B } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { applyOperations, type ManifestOperation } from "./ops.ts";

const manifest = makeManifest({
  sha: SHA_B,
  features: [
    makeFeature(),
    makeFeature({ id: "deliverables", title: "Deliverables", aliases: ["work items"] }),
  ],
  membership: {
    "src/signals/ingest.py": { featureId: "signals", weight: 0.9 },
    "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 },
    "src/signals/queue.py": { featureId: "signals", weight: 0.5 },
    "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.7 },
    "web/app.ts": { featureId: "deliverables", weight: 0.4 },
  },
});
const clusters = [
  { id: "c01", files: ["src/signals/ingest.py"] },
  { id: "c02", files: ["src/signals/queue.py"] },
  { id: "c03", files: ["src/deliverables/crud.py"] },
  { id: "c04", files: ["web/app.ts"] },
];
const op = (o: Partial<ManifestOperation> & Pick<ManifestOperation, "kind" | "feature">) => ({
  title: "",
  aliases: [],
  clusters: [],
  into: "",
  targets: [],
  ...o,
});
const apply = (...ops: ManifestOperation[]) => applyOperations(manifest, ops, clusters, SHA_B);
const featureOf = (m: Manifest | null, path: string) => m?.membership[path]?.featureId;

describe("applyOperations", () => {
  it("creates a feature from clusters, taking their files from whichever feature had them", () => {
    const {
      manifest: revised,
      affected,
      problems,
    } = apply(
      op({
        kind: "create",
        feature: "web-app",
        title: "Web app",
        aliases: ["UI", "frontend", "SPA"],
        clusters: ["c04"],
      }),
    );
    expect(problems).toEqual([]);
    expect(featureOf(revised, "web/app.ts")).toBe("web-app");
    expect(revised?.features.at(-1)).toEqual({
      id: "web-app",
      title: "Web app",
      aliases: ["UI", "frontend", "SPA"],
      status: { kind: "active" },
      lineage: [{ kind: "create", sha: SHA_B }],
    });
    expect(affected).toEqual(["deliverables", "web-app"]);
  });

  it("renames a feature, keeping its old title as an alias", () => {
    const { manifest: revised, affected } = apply(
      op({ kind: "rename", feature: "signals", title: "Signal pipeline" }),
    );
    const signals = revised?.features.find((f) => f.id === "signals");
    expect(signals).toMatchObject({
      title: "Signal pipeline",
      aliases: ["signal pipeline", "Signal ingestion"],
    });
    expect(signals?.lineage.at(-1)).toEqual({
      kind: "rename",
      sha: SHA_B,
      fromTitle: "Signal ingestion",
    });
    expect(affected).toEqual(["signals"]);
  });

  it("merges a feature into another, which takes its files and symbols", () => {
    const { manifest: revised, affected } = apply(
      op({ kind: "merge", feature: "deliverables", into: "signals" }),
    );
    expect(revised?.features.find((f) => f.id === "deliverables")?.status).toEqual({
      kind: "redirect",
      to: "signals",
    });
    expect(featureOf(revised, "web/app.ts")).toBe("signals");
    expect(affected).toEqual(["signals"]);
    expect(Manifest.safeParse(revised).success).toBe(true);
  });

  it("splits a feature by clusters into new features", () => {
    const {
      manifest: revised,
      affected,
      problems,
    } = apply(
      op({
        kind: "split",
        feature: "signals",
        targets: [
          {
            id: "ingestion",
            title: "Ingestion",
            aliases: ["intake", "ingest", "chunks"],
            clusters: ["c01"],
          },
          {
            id: "queueing",
            title: "Queueing",
            aliases: ["queue", "jobs", "workers"],
            clusters: ["c02"],
          },
        ],
      }),
    );
    expect(problems).toEqual([]);
    expect(revised?.features.find((f) => f.id === "signals")?.status).toEqual({
      kind: "disambiguation",
      to: ["ingestion", "queueing"],
    });
    expect(featureOf(revised, "src/signals/ingest.py#ingest_chunk")).toBe("ingestion");
    expect(affected).toEqual(["ingestion", "queueing"]);
  });

  it("moves clusters into a feature, then retires the emptied one", () => {
    const {
      manifest: revised,
      affected,
      problems,
    } = apply(
      op({ kind: "move", feature: "signals", clusters: ["c03", "c04"] }),
      op({ kind: "retire", feature: "deliverables" }),
    );
    expect(problems).toEqual([]);
    expect(revised?.features.find((f) => f.id === "deliverables")?.status).toEqual({
      kind: "retired",
    });
    expect(affected).toEqual(["signals"]);
  });

  it.each([
    [
      "an unknown feature",
      [op({ kind: "rename", feature: "ghost", title: "Ghost" })],
      '"ghost" is not an active feature',
    ],
    [
      "a reused id",
      [
        op({
          kind: "create",
          feature: "signals",
          title: "Again",
          aliases: ["a", "b", "c"],
          clusters: ["c04"],
        }),
      ],
      "already a feature id",
    ],
    [
      "a taken title",
      [op({ kind: "rename", feature: "signals", title: "deliverables" })],
      "is taken",
    ],
    [
      "too few aliases",
      [
        op({
          kind: "create",
          feature: "web-app",
          title: "Web app",
          aliases: ["UI"],
          clusters: ["c04"],
        }),
      ],
      "1 usable aliases",
    ],
    [
      "an unknown cluster",
      [op({ kind: "move", feature: "signals", clusters: ["c99"] })],
      'cluster "c99" does not exist',
    ],
    [
      "a cluster used twice",
      [
        op({ kind: "move", feature: "signals", clusters: ["c04"] }),
        op({ kind: "move", feature: "signals", clusters: ["c04"] }),
      ],
      "used by two operations",
    ],
    [
      "a retire with files left",
      [op({ kind: "retire", feature: "deliverables" })],
      "would leave 2 files without a feature",
    ],
    [
      "a split leaving files behind",
      [
        op({
          kind: "split",
          feature: "signals",
          targets: [
            { id: "ingestion", title: "Ingestion", aliases: ["a", "b", "c"], clusters: ["c01"] },
            { id: "other", title: "Other", aliases: ["d", "e", "f"], clusters: ["c04"] },
          ],
        }),
      ],
      "leaves 1 of its files without a target",
    ],
    [
      "an emptied feature",
      [op({ kind: "move", feature: "signals", clusters: ["c03", "c04"] })],
      '"deliverables" would have no files',
    ],
    [
      "a merge into itself",
      [op({ kind: "merge", feature: "signals", into: "signals" })],
      "is not another active feature",
    ],
    [
      "an alias that is another feature's title",
      [
        op({
          kind: "create",
          feature: "web-app",
          title: "Web app",
          aliases: ["UI", "frontend", " SIGNAL INGESTION "],
          clusters: ["c04"],
        }),
      ],
      'the alias "SIGNAL INGESTION" is taken by "signals" as its title',
    ],
    [
      "a title that is another feature's id",
      [
        op({
          kind: "create",
          feature: "web-app",
          title: "signals",
          aliases: ["UI", "frontend", "SPA"],
          clusters: ["c04"],
        }),
      ],
      'the title "signals" is taken by "signals" as its id',
    ],
    [
      "a split part whose alias is another feature's alias",
      [
        op({
          kind: "split",
          feature: "signals",
          targets: [
            { id: "ingestion", title: "Ingestion", aliases: ["a", "b", "c"], clusters: ["c01"] },
            {
              id: "queueing",
              title: "Queueing",
              aliases: ["d", "Work Items", "f"],
              clusters: ["c02"],
            },
          ],
        }),
      ],
      'the alias "Work Items" is taken by "deliverables" as its alias',
    ],
    [
      "a rename that gives another feature the old title of a renamed one",
      [
        op({ kind: "rename", feature: "signals", title: "Signal pipeline v2" }),
        op({ kind: "rename", feature: "deliverables", title: "Signal ingestion" }),
      ],
      'the title "Signal ingestion" is taken by "signals" as its alias',
    ],
    [
      "a rename to the current title in other letters",
      [op({ kind: "rename", feature: "signals", title: " signal INGESTION " })],
      "is already its title",
    ],
  ] as [string, ManifestOperation[], string][])(
    "refuses %s and applies nothing",
    (_name, ops, problem) => {
      const result = applyOperations(manifest, ops, clusters, SHA_B);
      expect(result.manifest).toBeNull();
      expect(result.problems.join("\n")).toContain(problem);
    },
  );

  const manifestWith = (features: Manifest["features"]): Manifest => ({
    ...manifest,
    features,
  });

  it("refuses a rename whose old title another feature already holds as an alias", () => {
    const held = manifestWith([
      makeFeature(),
      makeFeature({ id: "deliverables", title: "Deliverables", aliases: ["signal INGESTION"] }),
    ]);
    const result = applyOperations(
      held,
      [op({ kind: "rename", feature: "signals", title: "Signal pipeline v2" })],
      clusters,
      SHA_B,
    );
    expect(result.manifest).toBeNull();
    expect(result.problems.join("\n")).toContain(
      'the alias "Signal ingestion" is taken by "deliverables" as its alias',
    );
  });

  it("refuses a rename whose old title cannot be an alias", () => {
    const long = "L".repeat(70);
    const held = manifestWith([
      makeFeature({ title: long }),
      makeFeature({ id: "deliverables", title: "Deliverables", aliases: [] }),
    ]);
    const result = applyOperations(
      held,
      [op({ kind: "rename", feature: "signals", title: "Signals" })],
      clusters,
      SHA_B,
    );
    expect(result.manifest).toBeNull();
    expect(result.problems.join("\n")).toContain("cannot be kept as an alias");
  });

  it("refuses a rename that would pass the alias cap", () => {
    const full = Array.from({ length: 8 }, (_, i) => `alias ${i}`);
    const held = manifestWith([
      makeFeature({ aliases: full }),
      makeFeature({ id: "deliverables", title: "Deliverables", aliases: [] }),
    ]);
    const result = applyOperations(
      held,
      [op({ kind: "rename", feature: "signals", title: "Signals" })],
      clusters,
      SHA_B,
    );
    expect(result.manifest).toBeNull();
    expect(result.problems.join("\n")).toContain("would have 9 aliases; at most 8");
  });

  it("refuses a title with a control character and names it", () => {
    const result = apply(op({ kind: "rename", feature: "signals", title: "Sig\u202enals" }));
    expect(result.manifest).toBeNull();
    expect(result.problems.join("\n")).toContain("control or invisible character in its title");
  });

  it("reports an alias M3 would refuse instead of dropping it", () => {
    const result = apply(
      op({
        kind: "create",
        feature: "web-app",
        title: "Web app",
        aliases: ["UI", "frontend", "SPA", "x".repeat(70)],
        clusters: ["c04"],
      }),
    );
    expect(result.manifest).toBeNull();
    expect(result.problems.join("\n")).toContain("of 70 characters; use at most");
  });

  it("does not refuse an empty list over a feature that was already empty", () => {
    const orphaned = manifestWith([
      ...manifest.features,
      makeFeature({ id: "orphan", title: "Orphan", aliases: [] }),
    ]);
    expect(applyOperations(orphaned, [], clusters, SHA_B)).toEqual({
      manifest: orphaned,
      affected: [],
      problems: [],
    });
    const unrelated = applyOperations(
      orphaned,
      [op({ kind: "move", feature: "signals", clusters: ["c04"] })],
      clusters,
      SHA_B,
    );
    expect(unrelated.problems).toEqual([]);
    expect(unrelated.affected).toEqual(["deliverables", "signals"]);
  });

  it("still refuses an operation that touches an already-empty feature and leaves it empty", () => {
    const orphaned = manifestWith([
      ...manifest.features,
      makeFeature({ id: "orphan", title: "Orphan", aliases: [] }),
    ]);
    const result = applyOperations(
      orphaned,
      [op({ kind: "rename", feature: "orphan", title: "Orphans" })],
      clusters,
      SHA_B,
    );
    expect(result.problems.join("\n")).toContain('"orphan" would have no files');
  });

  it("applies an empty list as the manifest unchanged", () => {
    expect(apply()).toEqual({ manifest, affected: [], problems: [] });
  });
});
