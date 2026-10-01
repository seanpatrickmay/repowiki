import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("real-Node smoke test for openStore", () => {
  it("openStore works under real Node (not just vitest)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "repowiki-node-smoke-"));
    const dbPath = join(tempDir, "test.db");
    const storeIndexPath = new URL("./index.ts", import.meta.url).pathname;

    try {
      const script = `
import { openStore } from "${storeIndexPath}";
const store = openStore("${dbPath}");
const manifest = {
  sha: "${"a".repeat(40)}",
  seq: 1,
  features: [
    {
      id: "test",
      title: "Test Feature",
      aliases: [],
      status: { kind: "active" },
      lineage: [{ kind: "create", sha: "${"b".repeat(40)}" }],
    },
  ],
  membership: {},
};
store.putManifest(manifest);
const read = store.getManifest(manifest.sha);
if (read && read.features[0].id === "test") {
  console.log("ok");
} else {
  process.exit(1);
}
store.close();
`;

      const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      expect(output).toBe("ok");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
