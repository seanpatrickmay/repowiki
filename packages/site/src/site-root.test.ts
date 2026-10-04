import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMS_TXT_EXPORT_PATH, LLMS_TXT_FILE, renderLlmsTxt } from "@repowiki/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSiteRoot } from "./site-root.ts";
import { fixtureExport } from "./test-fixtures.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "repowiki-site-root-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeSiteRoot", () => {
  it("writes the export it validated and the llms.txt rendered from it, side by side", () => {
    const wiki = fixtureExport();
    writeSiteRoot(dir, wiki);
    expect(readdirSync(dir).sort()).toEqual([LLMS_TXT_EXPORT_PATH, LLMS_TXT_FILE].sort());
    expect(readFileSync(join(dir, LLMS_TXT_EXPORT_PATH), "utf8")).toBe(
      `${JSON.stringify(wiki, null, 2)}\n`,
    );
    expect(readFileSync(join(dir, LLMS_TXT_FILE), "utf8")).toBe(renderLlmsTxt(wiki));
  });
});
