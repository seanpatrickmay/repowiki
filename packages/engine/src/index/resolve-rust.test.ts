import { describe, expect, it } from "vitest";
import { parseCargoManifest } from "./cargo.ts";
import type { RawImport } from "./imports.ts";
import { createResolver } from "./resolve.ts";

const use = (path: string, scope: string[] = []): RawImport => ({
  kind: "rust-use",
  path: path.split("::"),
  scope,
  line: 1,
});
const mod = (name: string, scope: string[] = [], file: string | null = null): RawImport => ({
  kind: "rust-mod",
  name,
  scope,
  file,
  line: 1,
});

describe("rust resolution", () => {
  const files = [
    "Cargo.toml",
    "app/Cargo.toml",
    "app/src/engine.rs",
    "app/src/a.rs",
    "app/src/a/b.rs",
    "app/src/inline/c.rs",
    "app/src/bin/tool.rs",
    "app/src/bin/helper.rs",
    "app/src/gen/out.rs",
    "app/tests/it.rs",
    "app/tests/common/mod.rs",
    "loose/Cargo.toml",
    "loose/src/lib.rs",
    "loose/src/main.rs",
    "loose/src/m.rs",
    "fixtures/demo/Cargo.toml",
    "fixtures/demo/src/lib.rs",
  ];
  const resolver = createResolver(
    files,
    [],
    [
      parseCargoManifest("Cargo.toml", '[workspace]\nmembers = ["app", "loose"]\n'),
      parseCargoManifest(
        "app/Cargo.toml",
        '[package]\nname = "my-app"\n[lib]\npath = "src/engine.rs"\n',
      ),
      parseCargoManifest("loose/Cargo.toml", '[package\nname = "loose'),
      parseCargoManifest("fixtures/demo/Cargo.toml", '[package]\nname = "demo"\n'),
    ],
  );
  const hit = (...targets: string[]) => ({ targets, external: false });

  it.each([
    [
      "a [lib] path root declares children in its own directory",
      "app/src/engine.rs",
      mod("a"),
      hit("app/src/a.rs"),
    ],
    ["a.rs declares children in a/", "app/src/a.rs", mod("b"), hit("app/src/a/b.rs")],
    [
      "an inline module adds a directory",
      "app/src/engine.rs",
      mod("c", ["inline"]),
      hit("app/src/inline/c.rs"),
    ],
    [
      "a #[path] is relative to the file's directory",
      "app/src/a.rs",
      mod("x", [], "gen/out.rs"),
      hit("app/src/gen/out.rs"),
    ],
    [
      "a src/bin root declares children beside it",
      "app/src/bin/tool.rs",
      mod("helper"),
      hit("app/src/bin/helper.rs"),
    ],
    [
      "a tests/ root declares children beside it",
      "app/tests/it.rs",
      mod("common"),
      hit("app/tests/common/mod.rs"),
    ],
    ["a missing module file", "app/src/a.rs", mod("gone"), hit()],
    [
      "a crate by its package name with - as _",
      "app/tests/it.rs",
      use("my_app::a::b::Thing"),
      hit("app/src/a/b.rs"),
    ],
    ["an item of the crate root", "app/src/a/b.rs", use("crate::Engine"), hit("app/src/engine.rs")],
    ["super of a nested module", "app/src/a/b.rs", use("super::f"), hit("app/src/a.rs")],
    [
      "super out of an inline module",
      "app/src/a.rs",
      use("super::f", ["tests"]),
      hit("app/src/a.rs"),
    ],
    ["an item in scope, not a crate", "app/src/a.rs", use("Phase::*"), hit("app/src/a.rs")],
    [
      "a malformed manifest still has its src/lib.rs root",
      "loose/src/m.rs",
      use("crate::x"),
      hit("loose/src/lib.rs"),
    ],
    ["src/main.rs is a root", "loose/src/main.rs", mod("m"), hit("loose/src/m.rs")],
    ["super above the crate root", "app/src/engine.rs", use("super::x"), hit()],
  ])("%s", (_name, from, raw, expected) => {
    expect(resolver.resolve(from, raw)).toEqual(expected);
  });

  it.each([
    ["std", use("std::collections::HashMap")],
    ["core", use("core::fmt")],
    ["a crates.io dependency", use("serde::Serialize")],
    ["a crate outside the workspace members", use("demo::x")],
  ])("treats %s as external", (_name, raw) => {
    expect(resolver.resolve("app/src/a.rs", raw)).toEqual({ targets: [], external: true });
  });
});
