import { makeFeature, makeManifest, SHA_B } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { UnknownManifestError } from "./errors.ts";
import { openStore } from "./store.ts";

describe("amendManifestAliases", () => {
  it("adds new aliases only, keeps everything else, and stores the result", () => {
    const store = openStore(":memory:");
    store.putManifest(makeManifest(), { llmRevised: true });
    const amended = store.amendManifestAliases(makeManifest().sha, {
      signals: ["/api/signals", "SIGNAL PIPELINE", "Signal ingestion", " ", "SIGNALS_URL"],
      deliverables: ["deliverables_table"],
    });
    expect(amended.features.map((f) => f.aliases)).toEqual([
      ["signal pipeline", "/api/signals", "SIGNALS_URL"],
      ["deliverables_table"],
    ]);
    expect(store.getManifest(makeManifest().sha)).toEqual(amended);
    expect(store.getDriftBaseline()).toEqual(amended);
    expect(amended.membership).toEqual(makeManifest().membership);
    store.close();
  });

  it("refuses a sha with no stored manifest", () => {
    const store = openStore(":memory:");
    expect(() => store.amendManifestAliases(SHA_B, {})).toThrow(UnknownManifestError);
    store.close();
  });

  it("stores trimmed aliases, skips repeats within one call, and leaves llm_revised alone", () => {
    const store = openStore(":memory:");
    store.putManifest(makeManifest());
    const amended = store.amendManifestAliases(makeManifest().sha, {
      signals: ["  /api/signals ", "/API/SIGNALS", "SIGNALS_URL"],
      "not-a-feature": ["ignored"],
    });
    expect(amended.features[0]?.aliases).toEqual([
      "signal pipeline",
      "/api/signals",
      "SIGNALS_URL",
    ]);
    expect(amended.features.map((f) => f.id)).toEqual(["signals", "deliverables"]);
    expect(store.getDriftBaseline()).toBeNull();
    store.close();
  });

  it("does not read inherited properties for a feature id such as constructor", () => {
    const store = openStore(":memory:");
    const manifest = makeManifest({
      features: [makeFeature({ id: "constructor", title: "Constructor", aliases: [] })],
      membership: { "src/a.py": { featureId: "constructor", weight: 1 } },
    });
    store.putManifest(manifest);
    const amended = store.amendManifestAliases(manifest.sha, { toString: ["x"] });
    expect(amended).toEqual(manifest);
    store.close();
  });

  it("joins the caller's transaction, so a rollback undoes it", () => {
    const store = openStore(":memory:");
    store.putManifest(makeManifest());
    expect(() =>
      store.transaction(() => {
        store.amendManifestAliases(makeManifest().sha, { signals: ["/api/signals"] });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.getManifest(makeManifest().sha)).toEqual(makeManifest());
    store.close();
  });
});
