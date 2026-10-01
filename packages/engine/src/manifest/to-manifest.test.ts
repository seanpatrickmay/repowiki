import { Manifest } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import { buildFileGraph, clusterFiles } from "../cluster/index.ts";
import type { ManifestProposal } from "./proposal.ts";
import { sampleIndex } from "./test-index.ts";
import { proposalToManifest } from "./to-manifest.ts";

const index = sampleIndex();
const graph = buildFileGraph(index);
// c01: docs/C#.md + src/api/app.py; c02: routes + its test; c03: the web frontend.
const clusters = clusterFiles(graph, { resolution: 1, minClusterSize: 1 });

const API = { id: "http-api", title: "HTTP API", aliases: ["API server", "FastAPI app", "routes"] };
const WEB = {
  id: "web-frontend",
  title: "Web frontend",
  aliases: ["UI", "React app", "dashboard"],
};

function proposal(overrides: Partial<ManifestProposal> = {}): ManifestProposal {
  return {
    features: [API, WEB],
    clusters: [
      { cluster: "c01", feature: "http-api", role: "core" },
      { cluster: "c02", feature: "http-api", role: "supporting" },
      { cluster: "c03", feature: "web-frontend", role: "core" },
    ],
    ...overrides,
  };
}

describe("proposalToManifest", () => {
  const manifest = proposalToManifest(proposal(), index, graph, clusters);

  it("produces a valid manifest of new, active features created at the index sha", () => {
    expect(clusters.map((c) => c.files.length)).toEqual([2, 2, 2]);
    expect(Manifest.parse(manifest)).toEqual(manifest);
    expect(manifest.sha).toBe(index.sha);
    expect(manifest.features.map((f) => [f.id, f.status, f.lineage])).toEqual([
      ["http-api", { kind: "active" }, [{ kind: "create", sha: index.sha }]],
      ["web-frontend", { kind: "active" }, [{ kind: "create", sha: index.sha }]],
    ]);
  });

  it("makes every file and every symbol a member, keyed by memberId", () => {
    expect(Object.keys(manifest.membership).sort()).toEqual([
      "docs/C%23.md",
      "src/api/app.py",
      "src/api/app.py#App",
      "src/api/app.py#App.run",
      "src/api/app.py#create_app",
      "src/api/routes.py",
      "src/api/routes.py#router",
      "tests/test_routes.py",
      "tests/test_routes.py#test_list",
      "web/src/api.ts",
      "web/src/api.ts#fetchJson",
      "web/src/main.tsx",
      "web/src/main.tsx#Main",
    ]);
    expect(manifest.membership["src/api/app.py#App.run"]).toEqual(
      manifest.membership["src/api/app.py"],
    );
  });

  it("weighs members by role and by how much of their edge weight stays in the feature", () => {
    expect(manifest.membership["src/api/app.py"]).toEqual({ featureId: "http-api", weight: 1 });
    expect(manifest.membership["tests/test_routes.py"]).toEqual({
      featureId: "http-api",
      weight: 0.5,
    });
    const split = proposal({
      clusters: [
        { cluster: "c01", feature: "http-api", role: "core" },
        { cluster: "c02", feature: "web-frontend", role: "core" },
        { cluster: "c03", feature: "web-frontend", role: "core" },
      ],
    });
    // app.py's edges: 4/3 to docs (same feature) and 1.3 to routes.py (now another feature).
    expect(proposalToManifest(split, index, graph, clusters).membership["src/api/app.py"]).toEqual({
      featureId: "http-api",
      weight: 0.506,
    });
  });

  it("drops features with no clusters and caps aliases at eight", () => {
    const extra = proposal({
      features: [
        { ...API, aliases: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] },
        WEB,
        { id: "unused", title: "Unused", aliases: ["x", "y", "z"] },
      ],
    });
    const result = proposalToManifest(extra, index, graph, clusters);
    expect(result.features.map((f) => f.id)).toEqual(["http-api", "web-frontend"]);
    expect(result.features[0]?.aliases).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});

describe("proposalToManifest: stored strings are cleaned", () => {
  it("stores the trimmed title and the cleaned aliases, never the raw proposal strings", () => {
    const padded = proposal({
      features: [
        {
          id: "http-api",
          title: "  HTTP API  ",
          aliases: ["  API server ", "api SERVER", "http api", "", "  ", "routes"],
        },
        WEB,
      ],
    });
    const [first] = proposalToManifest(padded, index, graph, clusters).features;
    expect(first?.title).toBe("HTTP API");
    expect(first?.aliases).toEqual(["API server", "routes"]);
  });
});

describe("proposalToManifest: aliases stay unambiguous across features", () => {
  const build = (features: ManifestProposal["features"]) =>
    proposalToManifest(proposal({ features }), index, graph, clusters).features;

  it("drops an alias equal to another feature's id, ignoring case and padding", () => {
    const [api, web] = build([
      { ...API, aliases: [" Web-Frontend ", "API server", "routes"] },
      { ...WEB, aliases: ["http-API", "UI"] },
    ]);
    expect(api?.aliases).toEqual(["API server", "routes"]);
    expect(web?.aliases).toEqual(["UI"]);
  });

  it("drops an alias equal to another feature's title, ignoring case and padding", () => {
    const [api, web] = build([
      { ...API, title: " HTTP API ", aliases: ["  web FRONTEND ", "routes"] },
      { ...WEB, aliases: ["http api", "UI"] },
    ]);
    expect(api?.aliases).toEqual(["routes"]);
    expect(web?.aliases).toEqual(["UI"]);
  });

  it("gives a shared alias to the earlier feature only", () => {
    const [api, web] = build([
      { ...API, aliases: ["Gateway", "routes"] },
      { ...WEB, aliases: [" gateway ", "UI"] },
    ]);
    expect(api?.aliases).toEqual(["Gateway", "routes"]);
    expect(web?.aliases).toEqual(["UI"]);
  });

  it("keeps an alias equal to the feature's own id", () => {
    const [api] = build([{ ...API, aliases: ["http-api", "routes"] }, WEB]);
    expect(api?.aliases).toEqual(["http-api", "routes"]);
  });

  it("drops colliding aliases before capping, so the cap fills from later aliases", () => {
    const [api] = build([
      { ...API, aliases: ["web-frontend", "a", "b", "c", "d", "e", "f", "g", "h", "i"] },
      WEB,
    ]);
    expect(api?.aliases).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("does not let an alias cut by the cap claim the name", () => {
    const [api, web] = build([
      { ...API, aliases: ["a", "b", "c", "d", "e", "f", "g", "h", "Spare"] },
      { ...WEB, aliases: ["spare", "UI"] },
    ]);
    expect(api?.aliases).toHaveLength(8);
    expect(web?.aliases).toEqual(["spare", "UI"]);
  });

  it("does not let a dropped featureless feature claim a name", () => {
    const result = build([
      { id: "unused", title: "Unused", aliases: ["Gateway", "x"] },
      { ...API, aliases: ["unused", "routes"] },
      { ...WEB, aliases: ["gateway", "UI"] },
    ]);
    expect(result.map((f) => f.id)).toEqual(["http-api", "web-frontend"]);
    expect(result[0]?.aliases).toEqual(["unused", "routes"]);
    expect(result[1]?.aliases).toEqual(["gateway", "UI"]);
  });

  it("never throws on collisions, and the manifest still parses", () => {
    const result = proposalToManifest(
      proposal({
        features: [
          { ...API, aliases: ["web-frontend", "Web frontend"] },
          { ...WEB, aliases: ["http-api", "HTTP API"] },
        ],
      }),
      index,
      graph,
      clusters,
    );
    expect(result.features.map((f) => f.aliases)).toEqual([[], []]);
    expect(Manifest.parse(result)).toEqual(result);
  });
});

describe("proposalToManifest: the weight floor", () => {
  const alone = [
    { id: "c01", files: ["docs/C#.md"] },
    { id: "c02", files: ["src/api/app.py", "src/api/routes.py", "tests/test_routes.py"] },
    { id: "c03", files: ["web/src/api.ts", "web/src/main.tsx"] },
  ];
  const features = [{ id: "docs", title: "Docs", aliases: ["manual"] }, ...[API, WEB]];

  it("gives a member with none of its edge weight inside its feature the 0.05 floor, halved for supporting", () => {
    const core = proposalToManifest(
      proposal({
        features,
        clusters: [
          { cluster: "c01", feature: "docs", role: "core" },
          { cluster: "c02", feature: "http-api", role: "core" },
          { cluster: "c03", feature: "web-frontend", role: "core" },
        ],
      }),
      index,
      graph,
      alone,
    );
    expect(core.membership["docs/C%23.md"]).toEqual({ featureId: "docs", weight: 0.05 });
    const supporting = proposalToManifest(
      proposal({
        features,
        clusters: [
          { cluster: "c01", feature: "docs", role: "supporting" },
          { cluster: "c02", feature: "http-api", role: "core" },
          { cluster: "c03", feature: "web-frontend", role: "core" },
        ],
      }),
      index,
      graph,
      alone,
    );
    expect(supporting.membership["docs/C%23.md"]).toEqual({ featureId: "docs", weight: 0.025 });
  });

  it("floors a file with no edges at all instead of dividing by zero", () => {
    const result = proposalToManifest(
      proposal(),
      index,
      { nodes: graph.nodes, edges: [] },
      clusters,
    );
    expect(new Set(Object.values(result.membership).map((m) => m.weight))).toEqual(
      new Set([0.05, 0.025]),
    );
  });
});
