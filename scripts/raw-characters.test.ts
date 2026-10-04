import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Invisible characters a reviewer cannot see in a diff: soft hyphen, ALM, zero-width spaces and
 * joiners, LRM/RLM, bidi embeddings, overrides and isolates, word joiners and invisible operators,
 * the BOM, the linker's private-use markers U+E000/U+E001, and U+2028/U+2029. Source holds them
 * only as escapes.
 */
const RAW = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uE000\uE001\u2028\u2029]/u;

/** Recorded or generated text, and prose, may hold anything. */
const EXEMPT = /(^|\/)(node_modules|docs|__snapshots__|__cassettes__)$/;

/** The lines of `text` holding a raw invisible character, as "line: U+XXXX". */
function rawLines(text: string): string[] {
  return text.split("\n").flatMap((line, i) => {
    const found = RAW.exec(line)?.[0];
    if (found === undefined) return [];
    const code = (found.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    return [`${i + 1}: U+${code}`];
  });
}

describe("source files", () => {
  const paths = globSync("{packages,scripts}/**/*.{ts,astro,css,json}", {
    cwd: ROOT,
    exclude: (path) => EXEMPT.test(path),
  }).sort();

  it("are all found, in every package and the scripts", () => {
    for (const path of [
      "packages/core/src/alias.ts",
      "packages/engine/src/write/pack.ts",
      "packages/llm/src/claude.ts",
      "packages/site/src/model.ts",
      "scripts/wiki-build.ts",
    ]) {
      expect(paths).toContain(path);
    }
    expect(paths.some((path) => path.includes("__cassettes__"))).toBe(false);
  });

  it("hold invisible characters only as escapes", () => {
    const flagged = paths.flatMap((path) =>
      rawLines(readFileSync(`${ROOT}${path}`, "utf8")).map((line) => `${path}:${line}`),
    );
    expect(flagged).toEqual([]);
  });
});
