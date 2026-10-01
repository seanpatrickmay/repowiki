import { describe, expect, it } from "vitest";
import { Manifest } from "./manifest.ts";
import { makeFeature, makeManifest } from "./test-fixtures.ts";

describe("Manifest", () => {
  it("accepts a consistent manifest", () => {
    expect(Manifest.parse(makeManifest())).toEqual(makeManifest());
  });

  it("rejects duplicate feature ids", () => {
    expect(
      Manifest.safeParse(makeManifest({ features: [makeFeature(), makeFeature()] })).success,
    ).toBe(false);
  });

  it("rejects membership pointing at an unknown feature", () => {
    const membership = { "src/x.py": { featureId: "ghost", weight: 0.5 } };
    expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(false);
  });

  it("rejects membership pointing at a redirect", () => {
    const features = [
      makeFeature(),
      makeFeature({
        id: "deliverables",
        title: "Deliverables",
        status: { kind: "redirect", to: "signals" },
      }),
    ];
    expect(Manifest.safeParse(makeManifest({ features })).success).toBe(false);
  });

  it("rejects redirect targets that do not exist", () => {
    const features = [makeFeature({ status: { kind: "redirect", to: "ghost" } })];
    expect(Manifest.safeParse(makeManifest({ features, membership: {} })).success).toBe(false);
  });

  it("rejects weights outside (0, 1]", () => {
    const membership = { "src/x.py": { featureId: "signals", weight: 1.5 } };
    expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(false);
  });
});
