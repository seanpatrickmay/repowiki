import { memberId } from "@repowiki/core";
import { makeFeature, makeManifest } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { renderManifestSummary } from "./summary.ts";

const manifest = makeManifest({
  membership: {
    "src/signals/ingest.py": { featureId: "signals", weight: 0.9 },
    "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 },
    "src/signals/score.py": { featureId: "signals", weight: 0.4 },
    "docs/C%23.md": { featureId: "deliverables", weight: 0.5 },
  },
});

describe("renderManifestSummary", () => {
  const totals = {
    calls: 2,
    batchCalls: 2,
    tokens: { in: 1200, out: 3400, cacheRead: 15_000, cacheWrite: 15_000 },
    usd: 0.0187,
    unpricedCalls: 0,
  };
  const text = renderManifestSummary("demo", manifest, totals);

  it("lists every feature with its file and symbol counts", () => {
    expect(text).toContain("# Manifest: demo at aaaaaaa");
    expect(text).toContain("2 features, 3 files, 1 symbols.");
    expect(text).toContain("| `signals` | Signal ingestion | 2 | 1 |");
    expect(text).toContain("| `deliverables` | Deliverables | 1 | 0 |");
  });

  it("shows aliases and the heaviest files, decoding member ids", () => {
    expect(text).toContain("Aliases: signal pipeline");
    expect(text.indexOf("`src/signals/ingest.py` (0.9)")).toBeLessThan(
      text.indexOf("`src/signals/score.py` (0.4)"),
    );
    expect(text).toContain("`docs/C#.md` (0.5)");
  });

  it("ends with the token and dollar totals", () => {
    expect(text).toContain(
      "2 calls (2 batched): 1,200 input, 3,400 output, 15,000 cache-read, 15,000 cache-write tokens.",
    );
    expect(text).toContain("Cost: $0.0187.");
    expect(renderManifestSummary("demo", manifest, null)).not.toContain("LLM cost");
  });
});

describe("renderManifestSummary with model-supplied text", () => {
  const hostile = makeManifest({
    features: [
      makeFeature({
        id: "signals",
        title: "Ingest | score\n# injected",
        aliases: ["a|b", "line\nbreak"],
      }),
    ],
    membership: { "src/a.py": { featureId: "signals", weight: 0.9 } },
  });
  const text = renderManifestSummary("demo", hostile, null);

  it("keeps the feature table row on one line with its cells intact", () => {
    expect(text).toContain("| `signals` | Ingest \\| score # injected | 1 | 0 |");
  });

  it("never lets a title or alias start a new Markdown line", () => {
    expect(text).not.toMatch(/^# injected/m);
    expect(text).toContain("Aliases: a\\|b, line break");
  });
});

describe("renderManifestSummary file paths and repo name", () => {
  const render = (
    membership: Record<string, { featureId: string; weight: number }>,
    name = "demo",
  ) => renderManifestSummary(name, makeManifest({ features: [makeFeature()], membership }), null);

  it("renders a path containing backticks as a valid code span", () => {
    const text = render({
      "a`b.py": { featureId: "signals", weight: 0.9 },
      "``lead.py": { featureId: "signals", weight: 0.8 },
      "trail``": { featureId: "signals", weight: 0.7 },
    });
    expect(text).toContain("- ``a`b.py`` (0.9)");
    expect(text).toContain("- ``` ``lead.py ``` (0.8)");
    expect(text).toContain("- ``` trail`` ``` (0.7)");
  });

  it("does not let a path with line breaks start a new Markdown line", () => {
    const text = render({
      [memberId("x\n# injected\ny.py")]: { featureId: "signals", weight: 0.9 },
    });
    expect(text).not.toMatch(/^# injected/m);
    expect(text).toContain("- `x # injected y.py` (0.9)");
  });

  it("does not let a repo name with a line break start a new heading", () => {
    const text = render({ "a.py": { featureId: "signals", weight: 0.9 } }, "my\n# repo");
    expect(text).not.toMatch(/^# repo/m);
    expect(text).toContain("# Manifest: my # repo at aaaaaaa");
  });

  it("lists exactly the five heaviest files of a feature, ties broken by path", () => {
    const membership: Record<string, { featureId: string; weight: number }> = {};
    for (const [path, weight] of [
      ["f.py", 0.1],
      ["e.py", 0.5],
      ["d.py", 0.5],
      ["c.py", 0.9],
      ["b.py", 0.5],
      ["a.py", 0.7],
      ["g.py", 0.05],
    ] as const)
      membership[path] = { featureId: "signals", weight };
    const lines = render(membership)
      .split("\n")
      .filter((l) => l.startsWith("- `"));
    expect(lines).toEqual([
      "- `c.py` (0.9)",
      "- `a.py` (0.7)",
      "- `b.py` (0.5)",
      "- `d.py` (0.5)",
      "- `e.py` (0.5)",
    ]);
  });

  it("mentions calls to unpriced models in the cost line", () => {
    const text = renderManifestSummary("demo", makeManifest(), {
      calls: 3,
      batchCalls: 0,
      tokens: { in: 10, out: 20, cacheRead: 0, cacheWrite: 0 },
      usd: 0.5,
      unpricedCalls: 2,
    });
    expect(text).toContain("Cost: $0.5000 (plus 2 calls to unpriced models).");
  });
});
