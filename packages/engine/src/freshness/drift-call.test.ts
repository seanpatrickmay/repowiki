import { makeFeature, makeManifest, SHA_B } from "@repowiki/core/test-fixtures";
import { LlmError, LlmOutputError } from "@repowiki/llm";
import { describe, expect, it } from "vitest";
import { buildFileGraph, clusterFiles } from "../cluster/index.ts";
import { DRIFT_INSTRUCTIONS, reviseManifest } from "./drift-call.ts";
import { ManifestOperations } from "./ops.ts";
import { indexedFile, indexOf } from "./test-index.ts";
import { scriptedProvider } from "./test-provider.ts";

const index = indexOf(
  [
    indexedFile("src/signals/a.py"),
    indexedFile("src/signals/b.py"),
    indexedFile("src/deliverables/c.py"),
    indexedFile("src/deliverables/d.py"),
    indexedFile("web/app.ts"),
    indexedFile("web/view.ts"),
  ],
  [
    ["src/signals/a.py", "src/signals/b.py"],
    ["src/deliverables/c.py", "src/deliverables/d.py"],
    ["web/app.ts", "web/view.ts"],
  ],
);
const graph = buildFileGraph(index);
const clusterOptions = { resolution: 1, minClusterSize: 1 };
const webCluster = clusterFiles(graph, clusterOptions).find((c) => c.files.includes("web/app.ts"))
  ?.id as string;
const manifest = makeManifest({
  sha: SHA_B,
  features: [
    makeFeature(),
    makeFeature({ id: "deliverables", title: "Deliverables", aliases: [] }),
  ],
  membership: {
    "src/signals/a.py": { featureId: "signals", weight: 1 },
    "src/signals/b.py": { featureId: "signals", weight: 1 },
    "src/deliverables/c.py": { featureId: "deliverables", weight: 1 },
    "src/deliverables/d.py": { featureId: "deliverables", weight: 1 },
    "web/app.ts": { featureId: "deliverables", weight: 0.5 },
    "web/view.ts": { featureId: "deliverables", weight: 0.5 },
  },
});
const input = {
  repoName: "sample",
  manifest,
  index,
  graph,
  churn: new Map([
    ["signals", 0],
    ["deliverables", 0.5],
  ]),
  drifted: ["deliverables"],
  newFiles: new Set(["web/app.ts", "web/view.ts"]),
};
const create = {
  kind: "create",
  feature: "web-app",
  title: "Web app",
  aliases: ["UI", "frontend", "SPA"],
  clusters: [webCluster],
  into: "",
  targets: [],
};

describe("reviseManifest", () => {
  it("applies the operations of one batched manifest call over the clusters", async () => {
    const { provider, requests } = scriptedProvider(() => ({ operations: [create] }));
    const outcome = await reviseManifest(input, { provider, clusterOptions });
    expect(outcome.revised).toBe(true);
    expect(outcome.affected).toEqual(["deliverables", "web-app"]);
    expect(outcome.manifest.membership["web/view.ts"]?.featureId).toBe("web-app");
    expect(outcome.calls).toBe(1);
    expect(requests[0]).toMatchObject({
      purpose: "manifest",
      batch: true,
      schema: ManifestOperations,
    });
    expect(requests[0]?.cacheKey).toBeUndefined();
    const system = requests[0]?.system ?? "";
    expect(system.startsWith(DRIFT_INSTRUCTIONS)).toBe(true);
    expect(system).toContain("- deliverables: Deliverables; 4 files, 50% changed (drifted)");
    expect(system).toContain(
      `## ${webCluster}: 2 files (typescript 2), 2 new\nowned by: deliverables (2)`,
    );
  });

  it("takes an empty list as a revision that keeps the manifest", async () => {
    const { provider } = scriptedProvider(() => ({ operations: [] }));
    expect(await reviseManifest(input, { provider, clusterOptions })).toEqual({
      revised: true,
      manifest,
      affected: [],
      operations: [],
      calls: 1,
    });
  });

  it("sends refused operations back once with their problems", async () => {
    const { provider, requests } = scriptedProvider((_r, n) =>
      n === 1 ? { operations: [{ ...create, clusters: ["c99"] }] } : { operations: [create] },
    );
    const outcome = await reviseManifest(input, { provider, clusterOptions });
    expect(outcome).toMatchObject({ revised: true, calls: 2 });
    expect(requests[1]?.messages.at(-1)?.content).toContain('cluster "c99" does not exist');
    expect(requests[1]?.system).toBe(requests[0]?.system);
  });

  it("leaves the manifest unrevised after a second refusal, or two unusable answers", async () => {
    const lines: string[] = [];
    const { provider } = scriptedProvider(
      () => new LlmOutputError("model output is not JSON", "{"),
    );
    expect(
      await reviseManifest(input, { provider, clusterOptions, log: (l) => lines.push(l) }),
    ).toEqual({
      revised: false,
      manifest,
      affected: [],
      operations: [],
      calls: 2,
    });
    expect(lines.at(-1)).toBe("the manifest stays as it is; the next update asks again");
  });

  it("throws a provider failure", async () => {
    const { provider } = scriptedProvider(() => new LlmError("network"));
    await expect(reviseManifest(input, { provider, clusterOptions })).rejects.toThrow("network");
  });
});
