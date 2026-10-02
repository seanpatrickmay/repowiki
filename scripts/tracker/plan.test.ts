import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planSeed, type Seed, Seed as SeedSchema } from "./plan.ts";

const seed: Seed = {
  labels: [
    { name: "v1", color: "0e8a16", description: "Ships in v1" },
    { name: "type:feature", color: "a2eeef", description: "Feature register entry" },
    { name: "type:task", color: "ededed", description: "One PR-sized task" },
  ],
  issues: [
    { key: "F01", title: "[F01] Aliases", labels: ["v1", "type:feature"], body: "b" },
    {
      key: "M0-1",
      title: "[M0] Scaffold",
      labels: ["type:task"],
      body: "b",
      parent: "F01",
      closed: true,
    },
    { key: "M1-1", title: "[M1] Schemas", labels: ["type:task"], body: "b", parent: "F01" },
  ],
};

describe("Seed schema", () => {
  it("rejects duplicate keys", () => {
    const issues = [...seed.issues, { ...seed.issues[0], title: "[F01] Other" }];
    expect(SeedSchema.safeParse({ ...seed, issues }).success).toBe(false);
  });

  it("rejects duplicate titles", () => {
    const issues = [
      ...seed.issues,
      { key: "F02", title: "[F01] Aliases", labels: ["v1"], body: "b" },
    ];
    expect(SeedSchema.safeParse({ ...seed, issues }).success).toBe(false);
  });

  it("rejects labels that are not defined", () => {
    const issues = [{ key: "F01", title: "[F01] Aliases", labels: ["v9"], body: "b" }];
    expect(SeedSchema.safeParse({ ...seed, issues }).success).toBe(false);
  });

  it("rejects unknown parents", () => {
    const issues = [
      { key: "M1-1", title: "[M1] x", labels: ["type:task"], body: "b", parent: "F99" },
    ];
    expect(SeedSchema.safeParse({ ...seed, issues }).success).toBe(false);
  });
});

describe("planSeed", () => {
  it("upserts labels, then creates, links, and closes only new issues, in that order", () => {
    expect(planSeed(seed, []).map((a) => a.kind)).toEqual([
      "upsert-label",
      "upsert-label",
      "upsert-label",
      "create-issue",
      "create-issue",
      "create-issue",
      "link-parent",
      "link-parent",
      "close-issue",
    ]);
  });

  it("plans no create, link, or close for issues already seeded, linked, and closed", () => {
    const actions = planSeed(seed, [
      { number: 1, title: "[F01] Aliases", state: "OPEN", parentNumber: null },
      { number: 2, title: "[M0] Scaffold", state: "CLOSED", parentNumber: 1 },
      { number: 3, title: "[M1] Schemas", state: "OPEN", parentNumber: 1 },
    ]);
    expect(actions.filter((a) => a.kind !== "upsert-label")).toEqual([]);
  });

  it("resumes a partial run: links unlinked children and closes open ones without recreating", () => {
    const actions = planSeed(seed, [
      { number: 1, title: "[F01] Aliases", state: "OPEN", parentNumber: null },
      { number: 2, title: "[M0] Scaffold", state: "OPEN", parentNumber: null },
    ]);
    expect(actions.filter((a) => a.kind !== "upsert-label")).toEqual([
      { kind: "create-issue", issue: seed.issues[2] },
      { kind: "link-parent", childKey: "M0-1", parentKey: "F01" },
      { kind: "link-parent", childKey: "M1-1", parentKey: "F01" },
      { kind: "close-issue", key: "M0-1" },
    ]);
  });

  it("does not create when every issue exists but links and closes are missing", () => {
    const actions = planSeed(seed, [
      { number: 1, title: "[F01] Aliases", state: "OPEN", parentNumber: null },
      { number: 2, title: "[M0] Scaffold", state: "OPEN", parentNumber: 1 },
      { number: 3, title: "[M1] Schemas", state: "OPEN", parentNumber: null },
    ]);
    expect(actions.filter((a) => a.kind !== "upsert-label")).toEqual([
      { kind: "link-parent", childKey: "M1-1", parentKey: "F01" },
      { kind: "close-issue", key: "M0-1" },
    ]);
  });
});

describe("seed.json", () => {
  const raw: unknown = JSON.parse(readFileSync(new URL("./seed.json", import.meta.url), "utf8"));

  it("is a valid seed", () => {
    expect(SeedSchema.safeParse(raw).success).toBe(true);
  });

  it("contains the full feature register F01-F27", () => {
    const keys = SeedSchema.parse(raw)
      .issues.map((i) => i.key)
      .filter((k) => k.startsWith("F"));
    expect(keys).toEqual(
      Array.from({ length: 27 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`),
    );
  });
});
