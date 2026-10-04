import { beforeAll, describe, expect, it } from "vitest";
import { createSourceParser, type SourceLanguage, type SourceParser } from "./languages.ts";

let parser: SourceParser;
beforeAll(async () => {
  parser = await createSourceParser();
});

function hasError(language: SourceLanguage, source: string): boolean {
  const parsed = parser.parse(language, source);
  try {
    return parsed.hasError;
  } finally {
    parsed.dispose();
  }
}

// tree-sitter-typescript 0.23.2 (the latest release) reads `f<typeof import("x")>()` as the
// comparison `f < typeof import("x")` followed by an ERROR node `>()`. The source is valid.
describe("parse errors for an import type in call type arguments", () => {
  const valid = [
    'f<typeof import("x")>();',
    'const m = f<typeof import("x")>();\nexport const k = 1;\n',
    'const m = await importOriginal<typeof import("x")>();\n',
    'f<typeof import("x"), number>();',
    'f<typeof import("x") | null>();',
    'f<typeof import("x").default>();',
    'x.f<typeof import("x")>() ;',
    'f<typeof import("x")>().then(a);',
    'vi.mock("x", async (importOriginal) => {\n  const a = await importOriginal<typeof import("x")>();\n  return { ...a };\n});\n',
  ];

  it.each(valid)("is not an error in typescript: %s", (source) => {
    expect(hasError("typescript", source)).toBe(false);
  });

  it.each(valid)("is not an error in tsx: %s", (source) => {
    expect(hasError("tsx", source)).toBe(false);
  });

  it("still reports an unrelated syntax error next to the idiom", () => {
    expect(hasError("typescript", 'f<typeof import("x")>();\nexport function bad( {\n')).toBe(true);
    expect(hasError("typescript", 'f<typeof import("x")>(;\n')).toBe(true);
  });

  it("still reports an error that merely looks like `>()` after an expression", () => {
    expect(hasError("typescript", "const a = b >();\n")).toBe(true);
    expect(hasError("typescript", 'const a = typeof import("x") >();\n')).toBe(true);
  });
});
