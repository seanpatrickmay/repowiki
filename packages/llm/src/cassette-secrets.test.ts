import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SECRET = /sk-ant|x-api-key|authorization|anthropic-api-key/i;

describe("committed cassettes", () => {
  const paths = globSync("packages/*/src/**/__cassettes__/*.json", { cwd: ROOT }).sort();

  it("are all found, in every package", () => {
    expect(paths).toContain("packages/engine/src/manifest/__cassettes__/sample-manifest.json");
    expect(paths).toContain("packages/llm/src/__cassettes__/batch.json");
  });

  it.each(paths)("%s holds no API key or auth header", (path) => {
    expect(readFileSync(`${ROOT}${path}`, "utf8")).not.toMatch(SECRET);
  });
});
