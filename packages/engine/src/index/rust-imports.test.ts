import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepo } from "./build-index.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
  repo.write("Cargo.toml", '[workspace]\nmembers = [\n  "crates/*", # every crate\n]\n');
  repo.write(
    "crates/engine/Cargo.toml",
    '[package]\nname = "engine"\n\n[dependencies]\nserde = "1"\n',
  );
  repo.write(
    "crates/engine/src/lib.rs",
    [
      "pub mod board;",
      "pub mod rules;",
      "mod util;",
      "",
      "pub use board::Board;", // 5
      "use std::collections::HashMap;",
      "",
      "pub fn new_game() -> Board {",
      "    Board::new()",
      "}", // 10
    ].join("\n"),
  );
  repo.write(
    "crates/engine/src/board.rs",
    [
      "use crate::util::clamp;",
      "use super::rules::*;",
      "",
      "pub struct Board {",
      "    pub tiles: u8,", // 5
      "}",
      "",
      "impl Board {",
      "    pub fn new() -> Self {",
      "        Board { tiles: clamp(0) }", // 10
      "    }",
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {", // 15
      "    use super::*;",
      "",
      "    #[test]",
      "    fn builds() {",
      "        Board::new();", // 20
      "    }",
      "}",
    ].join("\n"),
  );
  repo.write("crates/engine/src/rules/mod.rs", "pub mod setup;\n\npub use self::setup::place;\n");
  repo.write(
    "crates/engine/src/rules/setup.rs",
    [
      "use crate::board::Board;",
      "use super::super::util;",
      "",
      "pub fn place(board: Board) -> Board {",
      "    util::clamp(board.tiles);", // 5
      "    board",
      "}",
    ].join("\n"),
  );
  repo.write("crates/engine/src/util.rs", "pub fn clamp(x: u8) -> u8 {\n    x.min(9)\n}\n");
  repo.write(
    "crates/cli/Cargo.toml",
    [
      "[package]",
      'name = "cli"',
      "",
      "[[bin]]",
      'name = "settle"',
      'path = "src/app.rs"',
      "",
      "[dependencies]",
      'engine = { path = "../engine" }',
      'clap = "4"',
    ].join("\n"),
  );
  repo.write(
    "crates/cli/src/app.rs",
    [
      "mod commands;",
      "",
      "use clap::Parser;",
      "use commands::{run as go, Mode};",
      "use engine::board::Board;", // 5
      "use engine::rules::{self, setup as s};",
      "",
      "fn main() {",
      "    let b = Board::new();",
      "    s::place(b);", // 10
      "    go(Mode::Fast);",
      "}",
    ].join("\n"),
  );
  repo.write(
    "crates/cli/src/commands.rs",
    "mod show;\n\npub enum Mode {\n    Fast,\n}\n\npub fn run(_mode: Mode) {\n    show::print();\n}\n",
  );
  repo.write(
    "crates/cli/src/commands/show.rs",
    "use crate::commands::Mode;\nuse std::collections::HashMap;\n\npub fn print() {}\n",
  );
  repo.commit("cargo workspace");
});
afterEach(() => repo.remove());

describe("indexRepo on a Cargo workspace", () => {
  it("makes edges for mod declarations and use paths, within and across crates", async () => {
    const index = await indexRepo(repo.dir, "HEAD");
    expect(index.imports).toEqual([
      { from: "crates/cli/src/app.rs", to: "crates/cli/src/commands.rs", line: 1 },
      { from: "crates/cli/src/app.rs", to: "crates/engine/src/board.rs", line: 5 },
      { from: "crates/cli/src/app.rs", to: "crates/engine/src/rules/mod.rs", line: 6 },
      { from: "crates/cli/src/app.rs", to: "crates/engine/src/rules/setup.rs", line: 6 },
      { from: "crates/cli/src/commands.rs", to: "crates/cli/src/commands/show.rs", line: 1 },
      { from: "crates/cli/src/commands/show.rs", to: "crates/cli/src/commands.rs", line: 1 },
      { from: "crates/engine/src/board.rs", to: "crates/engine/src/util.rs", line: 1 },
      { from: "crates/engine/src/board.rs", to: "crates/engine/src/rules/mod.rs", line: 2 },
      { from: "crates/engine/src/lib.rs", to: "crates/engine/src/board.rs", line: 1 },
      { from: "crates/engine/src/lib.rs", to: "crates/engine/src/rules/mod.rs", line: 2 },
      { from: "crates/engine/src/lib.rs", to: "crates/engine/src/util.rs", line: 3 },
      { from: "crates/engine/src/rules/mod.rs", to: "crates/engine/src/rules/setup.rs", line: 1 },
      { from: "crates/engine/src/rules/setup.rs", to: "crates/engine/src/board.rs", line: 1 },
      { from: "crates/engine/src/rules/setup.rs", to: "crates/engine/src/util.rs", line: 2 },
    ]);
    expect(index.unresolved).toEqual([
      { from: "crates/cli/src/app.rs", specifier: "clap::Parser", line: 3, external: true },
      {
        from: "crates/cli/src/commands/show.rs",
        specifier: "std::collections::HashMap",
        line: 2,
        external: true,
      },
      {
        from: "crates/engine/src/lib.rs",
        specifier: "std::collections::HashMap",
        line: 6,
        external: true,
      },
    ]);
  });
});
