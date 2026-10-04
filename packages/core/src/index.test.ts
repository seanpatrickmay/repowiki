import * as core from "@repowiki/core";
import { describe, expect, it } from "vitest";

describe("@repowiki/core public entry", () => {
  it("resolves by package name and exposes the schema version", () => {
    expect(core.SCHEMA_VERSION).toBe(2);
  });
});
