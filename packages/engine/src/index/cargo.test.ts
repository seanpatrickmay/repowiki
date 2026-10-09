import { describe, expect, it } from "vitest";
import { parseCargoManifest } from "./cargo.ts";

describe("parseCargoManifest", () => {
  it("reads the package name with - as _, [lib] and [[bin]] paths, and skips everything else", () => {
    const text = [
      "# The engine.",
      "[package]",
      'name = "settler-engine" # trailing comment',
      'version = "0.1.0"',
      'description = """',
      "A multi-line string with lines that look like TOML:",
      "[workspace]",
      'name = "not-this"',
      '"""',
      "",
      "[lib]",
      "path = 'src/engine.rs'",
      'crate-type = ["cdylib"]',
      "",
      "[[bin]]",
      'name = "settle"',
      'path = "src/bin/settle.rs"',
      "",
      "[[bin]]",
      'path = "tools/gen.rs"',
      "",
      "[dependencies]",
      'serde = { version = "1", features = ["derive"] }',
      'path = "not/a/bin.rs"',
    ].join("\n");
    expect(parseCargoManifest("crates/engine/Cargo.toml", text)).toEqual({
      dir: "crates/engine",
      crate: "settler_engine",
      package: true,
      lib: "crates/engine/src/engine.rs",
      bins: ["crates/engine/src/bin/settle.rs", "crates/engine/tools/gen.rs"],
      members: null,
    });
  });

  it("reads workspace members across lines, with comments, as repo paths", () => {
    const text = [
      "[workspace]",
      "members = [",
      '  "engine", # the core',
      "  # a comment line",
      "  'crates/*',",
      "]",
      'resolver = "2"',
    ].join("\n");
    expect(parseCargoManifest("Cargo.toml", text)).toEqual({
      dir: "",
      crate: null,
      package: false,
      lib: null,
      bins: [],
      members: ["engine", "crates/*"],
    });
    expect(parseCargoManifest("rust/Cargo.toml", text).members).toEqual([
      "rust/engine",
      "rust/crates/*",
    ]);
  });

  it.each([
    ["an unterminated header and string", '[package\nname = "x\n'],
    ["an unterminated array", '[lib]\npath = ["a", "b"\n'],
    ["a value of another type", "[lib]\npath = [1, 2]\n[package]\nname = 3\n"],
    ["binary noise", "\u0000\u0001[[[\"'''\n=\n"],
    ["nothing", ""],
  ])("falls back to a nameless package on %s", (_name, text) => {
    expect(parseCargoManifest("x/Cargo.toml", text)).toEqual({
      dir: "x",
      crate: null,
      package: true,
      lib: null,
      bins: [],
      members: null,
    });
  });
});
