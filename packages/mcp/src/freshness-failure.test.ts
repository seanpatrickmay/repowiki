import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HistoryWiki, historyWiki } from "@repowiki/query/test-wiki";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentTools } from "./agent-tools.ts";
import { serveWiki } from "./served.ts";

/**
 * A git on PATH that fails one subcommand and runs the real git for the rest, logging each call:
 * freshness is an addition to the wiki tools, so its failure must degrade them, never fail them
 * (spec v2 #5 R7 "serve, mark, never refuse", R16).
 */
let h: HistoryWiki;
let shim: string;
const savedPath = process.env.PATH;
beforeAll(() => {
  h = historyWiki();
  const real = execFileSync("sh", ["-c", "command -v git"]).toString("utf8").trim();
  shim = mkdtempSync(join(tmpdir(), "repowiki-fake-git-"));
  writeFileSync(
    join(shim, "git"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$REPOWIKI_TEST_GIT_LOG"',
      'for arg in "$@"; do',
      '  if [ "$arg" = "$REPOWIKI_TEST_GIT_FAIL" ]; then echo "fatal: injected failure" >&2; exit 128; fi',
      "done",
      `exec ${JSON.stringify(real)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(shim, "git"), 0o755);
});
afterAll(() => {
  h.repo.remove();
  rmSync(shim, { recursive: true, force: true });
});
afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.REPOWIKI_TEST_GIT_FAIL;
  delete process.env.REPOWIKI_TEST_GIT_LOG;
});

/** The six tools over the history fixture with git failing `subcommand`, and the call log. */
function failing(subcommand: string) {
  const log = join(shim, `${subcommand}.log`);
  writeFileSync(log, "");
  process.env.PATH = `${shim}:${savedPath}`;
  process.env.REPOWIKI_TEST_GIT_FAIL = subcommand;
  process.env.REPOWIKI_TEST_GIT_LOG = log;
  const served = serveWiki(h.wiki, { repo: h.repo.dir, pinned: null });
  const set = createAgentTools(() => served);
  const text = (name: string, input: unknown) => {
    const out = set.run(name, input) as { text: string; isError: boolean };
    return out.isError ? `ERROR ${out.text}` : out.text;
  };
  const calls = (word: string) =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.split(" ").includes(word)).length;
  return { text, calls };
}

describe("a freshness git failure", () => {
  it("leaves every wiki tool serving the wiki, with freshness unknown and why", () => {
    const { text, calls } = failing("diff-tree");
    const why = `git diff-tree failed in ${h.repo.dir}: fatal: injected failure`;

    const listed = text("list_pages", {});
    expect(listed.split("\n").slice(1, 3)).toEqual([
      `Freshness is unknown: ${why}; pages are served as written.`,
      "Uncommitted changes are not compared, and the marks cover cited lines only.",
    ]);
    expect(listed).toContain("- signals: Signal ingestion. ");

    expect(text("search", { query: "save_signal" })).toMatch(/^- signals: Signal ingestion\. /);

    const page = text("read_page", { id: "signals" });
    expect(page.split("\n").slice(0, 3)).toEqual([
      "Signal ingestion (page id: signals)",
      "Status: active. This revision: commit 3d751d3, 2026-01-04.",
      `Freshness is unknown: ${why}; the page is served unmarked.`,
    ]);
    expect(page).not.toContain("(changed since");

    expect(text("pages_for_file", { path: "src/signals/store.py" })).toContain(
      `\nWhether it changed since the wiki's commit is unknown: ${why}.\n`,
    );

    const code = text("cited_code", { id: "signals", ref: 2 });
    expect(code).toMatch(/^Reference \[2\] of signals: src\/signals\/store\.py:/);
    expect(code.endsWith(`\nWhere these lines are now is unknown: ${why}.\n`)).toBe(true);

    // Kept for the compare commit: a slow or failing repository is not asked again each call.
    expect(calls("diff-tree")).toBe(1);
  });

  it("serves a page unmarked when its marks fail, and does not ask again", () => {
    const { text, calls } = failing("diff");
    const page = text("read_page", { id: "signals" });
    expect(page.split("\n")[2]).toMatch(
      /^Freshness is unknown: git diff failed in .*; the page is served unmarked\.$/,
    );
    expect(page).toContain(
      "\n- `save_signal` appends each signal to the in-memory `SIGNALS` list. [2]\n",
    );
    expect(text("cited_code", { id: "signals", ref: 2 })).toMatch(
      /\nWhere these lines are now is unknown: git diff failed in .*\.\n$/,
    );
    expect(text("read_page", { id: "deliverables" }).split("\n")[2]).toMatch(
      /^Freshness is unknown: git diff failed/,
    );
    expect(calls("diff")).toBe(1);
  });
});
