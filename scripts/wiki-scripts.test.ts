import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentHash } from "@repowiki/core";
import {
  architectureClaim,
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makeArchitecture,
  makeFeature,
  makeManifest,
  makeRevision,
  SHA_A,
  SHA_B,
} from "@repowiki/core/test-fixtures";
import { openStore } from "@repowiki/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_LOCK } from "./wiki-cli.ts";

/** Damages every stored page body, as a hand-edited or half-migrated store would be. */
function corruptPages(out: string): void {
  const db = new DatabaseSync(join(out, "wiki.db"));
  db.exec("UPDATE revisions SET body = '{}'");
  db.close();
}

/** One redacted line and no stack: what a script prints for a bug, not a raw crash. */
function expectOneLineFailure(result: { status: number | null; stderr: string }): void {
  expect(result.status).toBe(1);
  const lines = result.stderr.split("\n").filter((line) => line !== "");
  // At most an estimate or progress line before the one error line, which is printable ASCII.
  expect(lines.length).toBeLessThanOrEqual(2);
  expect(lines.at(-1)).toMatch(/^[\x20-\x7e]+$/);
  expect(result.stderr).not.toMatch(/^\s+at /m);
  expect(result.stderr).not.toContain("node:internal");
}

let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "repowiki-wiki-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs a script with no API key and HOME in the scratch dir; nothing reaches the network. */
function run(script: string, ...args: string[]) {
  return runWith({}, script, ...args);
}

/** Variables that steer a request off the machine or choose its credentials, in any case. */
const OUTBOUND_ENV =
  /^(ANTHROPIC_.*|(HTTP|HTTPS|ALL|NO)_PROXY|NODE_USE_ENV_PROXY|REPOWIKI_CASSETTE)$/i;

/**
 * `run` with extra environment variables, for a test that sets a key and a dead endpoint. The
 * child gets none of the caller's API or proxy settings, only HOME and `extra` on top of the rest.
 */
function runWith(extra: NodeJS.ProcessEnv, script: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!OUTBOUND_ENV.test(name)) env[name] = value;
  }
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...env, HOME: dir, ...extra },
  });
}

/** A one-commit git repository under the scratch dir, its sha, and git run in it. */
function gitRepo(): { repo: string; sha: string; git: (...args: string[]) => string } {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { repo, sha: git("rev-parse", "HEAD").trim(), git };
}

describe("wiki-build.ts as a process (no network)", () => {
  /** A repo whose store holds a manifest at its head, so the build reaches its first call. */
  function storedRepo() {
    const { repo, sha } = gitRepo();
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(makeManifest({ sha }), { llmRevised: true });
    store.close();
    return { repo, out };
  }

  it("names the pnpm command and --env-file when the key is missing, and frees its lock", () => {
    const { repo, out } = storedRepo();
    const result = run("scripts/wiki-build.ts", repo, "--out", out);
    expect(result.status).toBe(1);
    const last = result.stderr.trimEnd().split("\n").at(-1) ?? "";
    expect(last).toContain("ANTHROPIC_API_KEY is not set");
    expect(last).toContain("pnpm wiki:build");
    expect(last).toContain("--env-file");
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
  });

  it("reports an unexpected error as one line, exits 1 and frees its lock", () => {
    const { repo, out } = wikiOf(["signals"], false);
    corruptPages(out);
    const result = run("scripts/wiki-build.ts", repo, "--out", out);
    expectOneLineFailure(result);
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
  });

  /**
   * A store at the repo's sha with three active features, pages stored for `paged` of them and,
   * when `article` is set, the project's article over those pages. Nothing is built at the head
   * unless a page is stored.
   */
  function wikiOf(paged: string[], article: boolean) {
    const { repo, sha } = gitRepo();
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(
      makeManifest({
        sha,
        features: [
          makeFeature(),
          makeFeature({ id: "deliverables", title: "Deliverables", aliases: [] }),
          makeFeature({ id: "extra", title: "Extra", aliases: [] }),
        ],
        membership: { "src/app.ts": { featureId: "extra", weight: 0.9 } },
      }),
      { llmRevised: true },
    );
    for (const featureId of paged) {
      store.putRevision(makeRevision({ id: `rev-${featureId}`, featureId, sha, seeAlso: [] }));
    }
    if (paged.length > 0) store.setHead(sha);
    if (article) {
      store.putArchitecture(
        makeArchitecture({
          id: `architecture-${sha.slice(0, 12)}-1`,
          sha,
          basis: paged.map((f) => `rev-${f}`).sort(),
          edges: [],
        }),
      );
    }
    store.close();
    return { repo, out, sha };
  }

  it("states the About article's estimate after the pages' line on a dry run, when it is due", () => {
    const { repo, out } = wikiOf([], false);
    const result = run("scripts/wiki-build.ts", repo, "--out", out, "--dry-run");
    expect(result.status).toBe(0);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^3 pages to write, about [\d,]+ input tokens: first round estimated at \$\d+\.\d{4} \(batched\)$/,
    );
    expect(lines[1]).toMatch(
      /^the About article: at most about [\d,]+ input tokens, estimated at \$\d+\.\d{4} \(batched\)$/,
    );
  });

  it("states no estimate for an article that is already current", () => {
    const { repo, out } = wikiOf(["signals", "deliverables", "extra"], true);
    const result = run("scripts/wiki-build.ts", repo, "--out", out, "--dry-run");
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("About article");
  });

  it("says the article is stored too when a rerun has nothing left to write, with no key", () => {
    const { repo, out, sha } = wikiOf(["signals", "deliverables", "extra"], true);
    const result = run("scripts/wiki-build.ts", repo, "--out", out);
    expect(result.status).toBe(0);
    expect(result.stderr.trimEnd().split("\n")).toEqual([
      "0 pages to write, about 0 input tokens: first round estimated at $0.0000 (batched)",
      `every page is already stored for ${sha}, and so is the About article; no LLM call made`,
    ]);
  });

  it("reports a page that fails again on a rerun and the article's failure, and exits 0 as for a partial failure", () => {
    const { repo, out, sha } = wikiOf(["signals", "deliverables"], false);
    // A placeholder key and an endpoint nothing listens on: every call fails to connect, which
    // is a failed page and a failed article, not a thrown error. Nothing leaves the machine.
    const result = runWith(
      { ANTHROPIC_API_KEY: "placeholder", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
      "scripts/wiki-build.ts",
      repo,
      "--out",
      out,
      "--no-batch",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 of 1 pages written, 0 claims dropped.");
    expect(result.stdout).toMatch(
      /^\| `extra` \| 0 \| 0 \| \d+ \| `the write call failed: APIConnectionError` \|$/m,
    );
    expect(result.stdout).toMatch(
      /^\| About article \| 0 \| 0 \| \d+ \| `the architecture call failed: APIConnectionError` \|$/m,
    );
    expect(existsSync(join(out, `build-${sha.slice(0, 7)}.md`))).toBe(true);
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
  }, 60_000);

  it("creates no out dir for a rev that names no commit", () => {
    const { repo } = gitRepo();
    const out = join(dir, "never");
    const result = run("scripts/wiki-build.ts", repo, "no-such-rev", "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"no-such-rev" does not name a commit');
    expect(existsSync(out)).toBe(false);
  });

  it("refuses to start while another build holds the lock, before any work", () => {
    const { repo, out } = storedRepo();
    writeFileSync(join(out, BUILD_LOCK), "pid 1 since 2026-10-01T00:00:00.000Z\n");
    const result = run("scripts/wiki-build.ts", repo, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `another wiki:build, wiki:update or wiki:replay is running on ${out} (${join(out, BUILD_LOCK)}); if none is, delete the lock file\n`,
    );
    expect(existsSync(join(out, BUILD_LOCK))).toBe(true);
  });
});

describe("wiki-check.ts as a process (no network)", () => {
  /** A store under `out` holding one page and the head, both at SHA_A. */
  function builtStore(): string {
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(makeManifest(), { llmRevised: true });
    store.putRevision(makeRevision());
    store.setHead(SHA_A);
    store.close();
    return out;
  }

  it("is a one-line usage error, exit 2, for a repository that does not exist", () => {
    const out = builtStore();
    const missing = join(dir, "nope");
    const result = run("scripts/wiki-check.ts", missing, "--out", out);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      `no such repository: ${missing}; usage: pnpm wiki:check <repo-path> [--out dir]\n`,
    );
  });

  it("is a one-line usage error, exit 2, for a repository without the wiki's sha", () => {
    const out = builtStore();
    const { repo } = gitRepo();
    const result = run("scripts/wiki-check.ts", repo, "--out", out);
    expect(result.status).toBe(2);
    expect(result.stderr.split("\n")).toHaveLength(2);
    expect(result.stderr).toMatch(
      new RegExp(`^${repo} does not hold ${SHA_A}, the sha the wiki was built at`),
    );
  });

  /** A store whose one page, at the repo's sha, cites a line of it and its commit `cited`. */
  function pageOf(repo: string, sha: string, cited: string): string {
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(makeManifest({ sha }), { llmRevised: true });
    const code = codeCitation({
      path: "src/app.ts",
      startLine: 1,
      endLine: 1,
      sha,
      symbol: null,
      contentHash: contentHash("export const app = 1;\n"),
    });
    store.putRevision(
      makeRevision({
        sha,
        sections: [
          { key: "lead", claims: [leadClaim({ supports: ["c-1", "h-1"] })] },
          { key: "overview", claims: [bodyClaim({ citations: [code] })] },
          {
            key: "history",
            claims: [
              bodyClaim({
                id: "h-1",
                kind: "history",
                citations: [commitCitation({ sha: cited, subject: "init", pr: null })],
              }),
            ],
          },
        ],
      }),
    );
    store.setHead(sha);
    store.close();
    return out;
  }

  it("counts the code citations it re-hashed and the commit citations it resolved", () => {
    const { repo, sha } = gitRepo();
    const result = run("scripts/wiki-check.ts", repo, "--out", pageOf(repo, sha, sha));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // The page's See also names deliverables, an active feature with no page.
    expect(result.stdout).toBe(
      "1 pages: 1 code citations re-hashed and 1 commit citations resolved; no problems\n" +
        "1 links name an active feature with no stored page (the site shows them as plain text)\n",
    );
  });

  it("reports a commit citation the repository's history does not hold", () => {
    const { repo, sha } = gitRepo();
    const result = run("scripts/wiki-check.ts", repo, "--out", pageOf(repo, sha, SHA_B));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "signals h-1 commit:bbbbbbb: no such commit in the history of the wiki's sha\n",
    );
    expect(result.stdout).toContain("1 problems");
  });

  /**
   * pageOf's store plus the project's article at the same sha, backed by `pages`, whose purpose
   * claim cites src/app.ts:1 with `hash`.
   */
  function withArticle(
    repo: string,
    sha: string,
    pages: string[],
    text = "Signals feed deliverables.",
    hash = contentHash("export const app = 1;\n"),
  ): string {
    const out = pageOf(repo, sha, sha);
    const store = openStore(join(out, "wiki.db"));
    const code = codeCitation({
      path: "src/app.ts",
      startLine: 1,
      endLine: 1,
      sha,
      symbol: null,
      contentHash: hash,
    });
    const [lead] = makeArchitecture().sections;
    store.putArchitecture(
      makeArchitecture({
        id: `architecture-${sha.slice(0, 12)}-1`,
        sha,
        edges: [],
        sections: [
          ...(lead === undefined ? [] : [lead]),
          { key: "purpose", claims: [architectureClaim({ text, citations: [code], pages })] },
        ],
      }),
    );
    store.close();
    return out;
  }

  it("checks the project's article with the pages", () => {
    const { repo, sha } = gitRepo();
    const result = run("scripts/wiki-check.ts", repo, "--out", withArticle(repo, sha, ["signals"]));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(
      "1 pages and the About article: 2 code citations re-hashed and 1 commit citations resolved; no problems",
    );
  });

  it("counts a page the article names that has none, as the pages' own links are", () => {
    const { repo, sha } = gitRepo();
    const out = withArticle(repo, sha, ["deliverables"]);
    const result = run("scripts/wiki-check.ts", repo, "--out", out);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // The page's See also names deliverables once, and the article names it once.
    expect(result.stdout).toContain("2 links name an active feature with no stored page");
  });

  it("reports a link in the article to an id that is not a feature", () => {
    const { repo, sha } = gitRepo();
    const out = withArticle(repo, sha, [], "Signals feed [[nowhere]].");
    const result = run("scripts/wiki-check.ts", repo, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('architecture "a-1": a link to "nowhere" is not a feature id\n');
  });

  it("reports an article citation whose lines no longer hash the same, labelled architecture", () => {
    const { repo, sha } = gitRepo();
    const stale = contentHash("export const app = 2;\n");
    const out = withArticle(repo, sha, ["signals"], undefined, stale);
    const result = run("scripts/wiki-check.ts", repo, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("architecture a-1 src/app.ts:1-1: the cited lines changed\n");
    expect(result.stdout).toContain(
      "2 code citations re-hashed and 1 commit citations resolved; 1 problems",
    );
  });

  it("judges a carried page's links at its own sha, after a later merge made one a redirect", () => {
    const { repo, sha } = gitRepo();
    const out = pageOf(repo, sha, sha);
    const store = openStore(join(out, "wiki.db"));
    // An update at a later commit merged deliverables into signals; the page carried forward.
    store.putManifest(
      makeManifest({
        sha: SHA_B,
        features: [
          makeFeature(),
          makeFeature({
            id: "deliverables",
            title: "Deliverables",
            aliases: [],
            status: { kind: "redirect", to: "signals" },
            lineage: [
              { kind: "create", sha: SHA_A },
              { kind: "merge", sha: SHA_B, into: "signals" },
            ],
          }),
        ],
        membership: { "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 } },
      }),
    );
    store.close();
    const result = run("scripts/wiki-check.ts", repo, "--out", out);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  /** The page and article of withArticle, then a later manifest that retired deliverables. */
  function retiredLater(text: string, pages: string[]): { repo: string; out: string } {
    const { repo, sha } = gitRepo();
    const out = withArticle(repo, sha, pages, text);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(
      makeManifest({
        sha: SHA_B,
        features: [
          makeFeature(),
          makeFeature({
            id: "deliverables",
            title: "Deliverables",
            aliases: [],
            status: { kind: "retired" },
            lineage: [
              { kind: "create", sha: SHA_A },
              { kind: "retire", sha: SHA_B },
            ],
          }),
        ],
        membership: { "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 } },
      }),
    );
    store.close();
    return { repo, out };
  }

  it("reports an article link to a feature that retired since, with no page", () => {
    const { repo, out } = retiredLater("Signals feed [[deliverables]].", []);
    const result = run("scripts/wiki-check.ts", repo, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'signals: See also lists "deliverables", which no longer leads to a page\n' +
        'architecture "a-1": a link to "deliverables" no longer leads to a page\n',
    );
  });

  it("reports an article page that retired since, with no page", () => {
    const { repo, out } = retiredLater("Signals feed deliverables.", ["deliverables"]);
    const result = run("scripts/wiki-check.ts", repo, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'signals: See also lists "deliverables", which no longer leads to a page\n' +
        'architecture "a-1": names "deliverables", which no longer leads to a page\n',
    );
  });

  it("counts, without failing, an article page that is still active with no page", () => {
    const { repo, sha } = gitRepo();
    const out = withArticle(repo, sha, ["deliverables"], "Signals feed [[deliverables]].");
    const result = run("scripts/wiki-check.ts", repo, "--out", out);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("3 links name an active feature with no stored page");
  });
});

describe("wiki-update.ts as a process (no network)", () => {
  /**
   * gitRepo's repository and a store under `out` whose wiki is at its commit. "pending": two
   * features, only signals with a page, citing line 1 of src/app.ts (deliverables is written
   * whole). "single": signals is the only feature. "paged": both features have a page citing
   * line 1 of their file, and no article is stored.
   */
  function storedWiki(kind: "pending" | "single" | "paged" = "pending") {
    const { repo, sha: base, git } = gitRepo();
    let sha = base;
    if (kind === "paged") {
      writeFileSync(join(repo, "src", "other.ts"), "export const other = 1;\n");
      git("add", "-A");
      git("commit", "-q", "-m", "other");
      sha = git("rev-parse", "HEAD").trim();
    }
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    // Files and their symbols, as indexRepo names them: a manifest without the symbols would
    // read as churn against the index and call for a drift round.
    const membership: Record<string, { featureId: string; weight: number }> = {
      "src/app.ts": { featureId: "signals", weight: 1 },
      "src/app.ts#app": { featureId: "signals", weight: 1 },
    };
    if (kind === "paged") {
      membership["src/other.ts"] = { featureId: "deliverables", weight: 1 };
      membership["src/other.ts#other"] = { featureId: "deliverables", weight: 1 };
    }
    store.putManifest(
      makeManifest({
        sha,
        membership,
        ...(kind === "single" ? { features: [makeFeature()] } : {}),
      }),
      { llmRevised: true },
    );
    const page = (featureId: string, path: string, line: string) =>
      makeRevision({
        id: `${featureId}-1`,
        featureId,
        sha,
        seeAlso: [],
        sections: [
          { key: "lead", claims: [leadClaim()] },
          {
            key: "overview",
            claims: [
              bodyClaim({
                citations: [
                  codeCitation({
                    path,
                    startLine: 1,
                    endLine: 1,
                    sha,
                    symbol: null,
                    contentHash: contentHash(line),
                  }),
                ],
              }),
            ],
          },
        ],
      });
    store.putRevision(page("signals", "src/app.ts", "export const app = 1;\n"));
    if (kind === "paged") {
      store.putRevision(page("deliverables", "src/other.ts", "export const other = 1;\n"));
    }
    store.setHead(sha);
    store.close();
    return { repo, out, sha, git };
  }

  /** storedWiki("pending") with a second commit that edits the line the stored page cites. */
  function updatable(): { repo: string; out: string; first: string; second: string } {
    const { repo, out, sha, git } = storedWiki();
    writeFileSync(join(repo, "src", "app.ts"), "export const app = 2;\n");
    git("commit", "-q", "-am", "Merge pull request #3 from me/app");
    return { repo, out, first: sha, second: git("rev-parse", "HEAD").trim() };
  }

  /** A second commit that changes no file: nothing to update. */
  function untouched(kind: "single" | "paged") {
    const { repo, out, sha, git } = storedWiki(kind);
    git("commit", "-q", "--allow-empty", "-m", "chore: nothing");
    return { repo, out, first: sha, second: git("rev-parse", "HEAD").trim() };
  }

  it("is a usage error, exit 2, without its two positionals", () => {
    const result = run("scripts/wiki-update.ts", "../repo");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^usage: pnpm wiki:update <repo-path> <rev> /);
  });

  it("is a one-line error, exit 1, when there is no wiki to update", () => {
    const { repo, sha } = gitRepo();
    const out = join(dir, "empty");
    const result = run("scripts/wiki-update.ts", repo, sha, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`no wiki at ${join(out, "wiki.db")}; run pnpm wiki:build first\n`);
  });

  it("states the estimate on a dry run and stops there, holding no lock", () => {
    const { repo, out, first, second } = updatable();
    const result = run("scripts/wiki-update.ts", repo, second, "--out", out, "--dry-run");
    expect(result.stderr).toMatch(
      /^1 pages to update, 1 to write whole, \d small calls: about [\d,]+ input tokens, estimated at \$\d+\.\d{4} \(batched\), plus at most \$\d+\.\d{4} if the About article is due\n$/,
    );
    expect(result.status).toBe(0);
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
    expect(existsSync(join(out, "export.json"))).toBe(false);
    const store = openStore(join(out, "wiki.db"));
    expect(store.getHead()).toBe(first);
    store.close();
  });

  it("refuses the commit the wiki is already at, in one line", () => {
    const { repo, out, first } = updatable();
    const result = run("scripts/wiki-update.ts", repo, first, "--out", out, "--dry-run");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`the wiki is already at ${first}\n`);
  });

  it("fails once, up front, naming wiki:update, when calls are due and there is no key", () => {
    const { repo, out, first, second } = updatable();
    const result = run("scripts/wiki-update.ts", repo, second, "--out", out);
    expect(result.status).toBe(1);
    const message =
      "ANTHROPIC_API_KEY is not set: pnpm wiki:update reads it from a .env file in the directory it runs in, if there is one (node --env-file-if-exists=.env); add it there, or run node --env-file=<path to .env> scripts/wiki-update.ts";
    expect(result.stderr).toMatch(
      new RegExp(
        `^1 pages to update, 1 to write whole, [^\\n]*\\n${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n$`,
      ),
    );
    expect(result.stderr).not.toContain("wiki:build");
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
    const store = openStore(join(out, "wiki.db"));
    expect(store.getHead()).toBe(first);
    store.close();
  });

  it("needs no key when nothing cited changed, and writes its export and summary", () => {
    const { repo, out, second } = untouched("single");
    const result = run("scripts/wiki-update.ts", repo, second, "--out", out);
    expect(result.stderr).toMatch(/^0 pages to update, 0 to write whole, 0 small calls: [^\n]*\n$/);
    expect(result.status).toBe(0);
    const summaryPath = join(out, `update-${second.slice(0, 7)}.md`);
    expect(readFileSync(summaryPath, "utf8")).toContain("0 pages stored, 1 carried forward");
    expect(result.stdout).toContain(`Wrote ${join(out, "export.json")} and ${summaryPath}`);
    expect(JSON.parse(readFileSync(join(out, "export.json"), "utf8")).repo).toBe("repo");
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
    expect(readdirSync(out).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const store = openStore(join(out, "wiki.db"));
    expect(store.getHead()).toBe(second);
    store.close();
  });

  it("replaces a symlink at the summary's name instead of writing through it", () => {
    const { repo, out, second } = untouched("single");
    const target = join(dir, "outside.md");
    writeFileSync(target, "keep\n");
    const summaryPath = join(out, `update-${second.slice(0, 7)}.md`);
    symlinkSync(target, summaryPath);
    const result = run("scripts/wiki-update.ts", repo, second, "--out", out);
    expect(result.status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(lstatSync(summaryPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(summaryPath, "utf8")).toContain("# Update:");
  });

  it("fails up front, with the head unmoved, when the About article is the only call and there is no key", () => {
    const { repo, out, first, second } = untouched("paged");
    const result = run("scripts/wiki-update.ts", repo, second, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY is not set");
    const store = openStore(join(out, "wiki.db"));
    expect(store.getHead()).toBe(first);
    store.close();
  });

  it("estimates a merge that adds a file its signals cannot place, counting the tie-break call", () => {
    const { repo, out, sha: first, git } = storedWiki("paged");
    // lib/new.ts has no import, co-change or directory signal: it is disputed between both features.
    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib", "new.ts"), "export const fresh = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Merge pull request #3 from me/lib");
    const second = git("rev-parse", "HEAD").trim();
    const result = run("scripts/wiki-update.ts", repo, second, "--out", out, "--dry-run");
    expect(result.stderr).not.toContain("no feature for the new file");
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/, 1 small calls: about [\d,]+ input tokens/);
    const store = openStore(join(out, "wiki.db"));
    expect(store.getHead()).toBe(first);
    store.close();
  });

  it("reports an unexpected error as one line, exits 1 and frees its lock", () => {
    const { repo, out, second } = updatable();
    corruptPages(out);
    const result = run("scripts/wiki-update.ts", repo, second, "--out", out);
    expectOneLineFailure(result);
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
  });

  it("states the About article's cost when no page is dirty but the article is due", () => {
    const { repo, out, second } = untouched("paged");
    const result = run("scripts/wiki-update.ts", repo, second, "--out", out, "--dry-run");
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(
      /^0 pages to update, 0 to write whole, 0 small calls: about 0 input tokens, estimated at \$0\.0000 \(batched\), plus at most \$(?!0\.0000)\d+\.\d{4} if the About article is due\n$/,
    );
  });

  it("refuses a target that is not after the wiki's commit, in one line", () => {
    const { repo, out, first } = updatable();
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.com",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.com",
        },
      });
    git("switch", "-q", "--orphan", "other");
    writeFileSync(join(repo, "x.ts"), "export const x = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "other root");
    const other = git("rev-parse", "HEAD").trim();
    const result = run("scripts/wiki-update.ts", repo, other, "--out", out, "--dry-run");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `${first} is not an ancestor of ${other}; an update only moves forward along history\n`,
    );
  });

  it("is a one-line error, exit 1, for a rev that names no commit", () => {
    const { repo, out } = updatable();
    const result = run("scripts/wiki-update.ts", repo, "no-such-rev", "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${repo}: "no-such-rev" does not name a commit\n`);
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
  });

  it("refuses to start while another run holds the lock, and leaves the lock alone", () => {
    const { repo, out, second } = updatable();
    writeFileSync(join(out, BUILD_LOCK), "pid 1 since 2026-10-01T00:00:00.000Z\n");
    const result = run("scripts/wiki-update.ts", repo, second, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `another wiki:build, wiki:update or wiki:replay is running on ${out} (${join(out, BUILD_LOCK)}); if none is, delete the lock file\n`,
    );
    expect(existsSync(join(out, BUILD_LOCK))).toBe(true);
  });
});

describe("wiki-replay.ts as a process (no network)", () => {
  /**
   * gitRepo's repository, a store whose one feature (signals, owning src/app.ts) has a page at
   * its commit, then two merges: #4 adds and removes a scratch file (no net change: an update
   * with no call), #5 edits the line the page cites (an update that needs one).
   * `paged` stores a second feature (deliverables, owning src/other.ts) with a page and no About
   * article, which is then due; `twoQuiet` adds another no-call merge (#6) before #5.
   */
  function replayable(
    brokenClaimId: string | null = null,
    { paged = false, twoQuiet = false } = {},
  ) {
    const { repo, sha: base, git } = gitRepo();
    let first = base;
    if (paged) {
      writeFileSync(join(repo, "src", "other.ts"), "export const other = 1;\n");
      git("add", "-A");
      git("commit", "-q", "-m", "other");
      first = git("rev-parse", "HEAD").trim();
    }
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(
      makeManifest({
        sha: first,
        ...(paged ? {} : { features: [makeFeature()] }),
        // Every file and symbol, as a built manifest holds them: an update then sees no churn.
        membership: {
          "src/app.ts": { featureId: "signals", weight: 1 },
          "src/app.ts#app": { featureId: "signals", weight: 1 },
          ...(paged
            ? {
                "src/other.ts": { featureId: "deliverables", weight: 1 },
                "src/other.ts#other": { featureId: "deliverables", weight: 1 },
              }
            : {}),
        },
      }),
      { llmRevised: true },
    );
    const code = codeCitation({
      path: "src/app.ts",
      startLine: 1,
      endLine: 1,
      sha: first,
      symbol: null,
      contentHash: contentHash("export const app = 1;\n"),
    });
    store.putRevision(
      makeRevision({
        sha: first,
        seeAlso: [],
        sections: [
          {
            key: "lead",
            claims: [leadClaim(brokenClaimId === null ? {} : { supports: [brokenClaimId] })],
          },
          {
            key: "overview",
            claims: [
              bodyClaim({
                ...(brokenClaimId === null ? {} : { id: brokenClaimId }),
                // The broken page also cites a commit the history lacks, which the check reports.
                citations: brokenClaimId === null ? [code] : [code, commitCitation()],
              }),
            ],
          },
        ],
      }),
    );
    if (paged) {
      store.putRevision(
        makeRevision({
          id: "deliverables-1",
          featureId: "deliverables",
          sha: first,
          seeAlso: [],
          sections: [
            { key: "lead", claims: [leadClaim()] },
            {
              key: "overview",
              claims: [
                bodyClaim({
                  citations: [
                    codeCitation({
                      path: "src/other.ts",
                      startLine: 1,
                      endLine: 1,
                      sha: first,
                      symbol: null,
                      contentHash: contentHash("export const other = 1;\n"),
                    }),
                  ],
                }),
              ],
            },
          ],
        }),
      );
    }
    store.setHead(first);
    store.close();
    const merge = (branch: string, edit: () => void, pr: number) => {
      git("switch", "-q", "-c", branch);
      edit();
      git("switch", "-q", "main");
      git("merge", "-q", "--no-ff", "-m", `Merge pull request #${pr} from me/${branch}`, branch);
      return git("rev-parse", "HEAD").trim();
    };
    const quiet = merge(
      "scratch",
      () => {
        writeFileSync(join(repo, "scratch.txt"), "tmp\n");
        git("add", "-A");
        git("commit", "-q", "-m", "add scratch");
        git("rm", "-q", "scratch.txt");
        git("commit", "-q", "-m", "remove scratch");
      },
      4,
    );
    const quiet2 = twoQuiet
      ? merge(
          "scratch2",
          () => {
            writeFileSync(join(repo, "scratch2.txt"), "tmp\n");
            git("add", "-A");
            git("commit", "-q", "-m", "add scratch2");
            git("rm", "-q", "scratch2.txt");
            git("commit", "-q", "-m", "remove scratch2");
          },
          6,
        )
      : null;
    const loud = merge(
      "app",
      () => {
        writeFileSync(join(repo, "src", "app.ts"), "export const app = 2;\n");
        git("commit", "-q", "-am", "edit app");
      },
      5,
    );
    return { repo, out, first, quiet, quiet2, loud, git };
  }

  it("is a usage error, exit 2, without its three positionals", () => {
    const result = run("scripts/wiki-replay.ts", "../repo", "abc");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^usage: pnpm wiki:replay <repo-path> <from-rev> <to-rev> /);
  });

  it("lists the merges with an upper-side estimate on a dry run, as many as --limit allows", () => {
    const { repo, out, first, quiet, loud } = replayable();
    const all = run("scripts/wiki-replay.ts", repo, first, loud, "--out", out, "--dry-run");
    expect(all.status).toBe(0);
    const rows = all.stdout.split("\n").filter((line) => /^\| \d/.test(line));
    expect(rows.map((row) => row.split(" | ").slice(1, 3))).toEqual([
      [quiet.slice(0, 7), "4"],
      [loud.slice(0, 7), "5"],
    ]);
    expect(rows.map((row) => row.split(" | ")[5])).toEqual(["0", "1"]);
    expect(all.stdout).toMatch(
      /2 steps estimated at about \$\d+\.\d{4}\.\nUpper-side for the update and tie-break calls only: [^\n]+\n$/,
    );
    const one = run(
      "scripts/wiki-replay.ts",
      repo,
      first,
      loud,
      "--out",
      out,
      "--dry-run",
      "--limit",
      "1",
    );
    expect(one.stdout).toContain("1 more steps after them are left for a later run");
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
  });

  it("replays a step with no call, stops at the first call without a key, and resumes there", () => {
    const { repo, out, first, quiet, loud } = replayable();
    const result = run("scripts/wiki-replay.ts", repo, first, loud, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY is not set");
    expect(result.stderr).toContain("pnpm wiki:replay");
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
    const store = openStore(join(out, "wiki.db"));
    expect(store.getHead()).toBe(quiet);
    expect(store.getManifest(quiet)).not.toBeNull();
    store.close();
    const summary = readFileSync(
      join(out, `replay-${first.slice(0, 7)}-${loud.slice(0, 7)}.md`),
      "utf8",
    );
    expect(summary).toContain("1 steps replayed, 1 left");
    // The store holds no build run, so the token invariant was not compared, and says so.
    expect(summary).toContain("token invariant not checked (no build run in the ledger)");
    expect(summary).not.toContain("hold for every step");
    // A rerun starts from the wiki's head: only the step that failed is left.
    const again = run("scripts/wiki-replay.ts", repo, first, loud, "--out", out, "--dry-run");
    expect(again.stdout.split("\n").filter((line) => /^\| \d/.test(line))).toHaveLength(1);
  });

  it("prints a problem line as one printable line, however its quoted path is spelled", () => {
    // A claim whose citation no longer matches: the check's problem names its id, bidi included.
    const { repo, out, first, quiet } = replayable("c-\u202e1\u0007");
    const result = run("scripts/wiki-replay.ts", repo, first, quiet, "--out", out);
    // The broken invariant is the exit code too.
    expect(result.status).toBe(1);
    const problems = result.stderr.split("\n").filter((line) => line.startsWith(quiet.slice(0, 7)));
    expect(problems.length).toBeGreaterThan(0);
    for (const line of problems) {
      expect(line).toMatch(/^[\x20-\x7e]+$/);
      expect(line.length).toBeLessThanOrEqual(300);
    }
    expect(problems.join("\n")).toContain("c-?1?");
  });

  it("prices the About article on a dry run when it is already due and no page is touched", () => {
    const { repo, out, first, quiet } = replayable(null, { paged: true });
    const result = run("scripts/wiki-replay.ts", repo, first, quiet, "--out", out, "--dry-run");
    expect(result.status).toBe(0);
    const [row] = result.stdout.split("\n").filter((line) => /^\| \d/.test(line));
    expect(row?.split(" | ")[5]).toBe("0");
    expect(row).not.toMatch(/\$0\.0000 \|$/);
    expect(result.stdout).toMatch(/1 steps estimated at about \$(?!0\.0000)\d+\.\d{4}\./);
  });

  it("projects a merge that adds a file its signals cannot place, with a tie-break call priced", () => {
    const { repo, out, first, git } = replayable(null, { paged: true });
    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib", "new.ts"), "export const fresh = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Merge pull request #7 from me/lib");
    const added = git("rev-parse", "HEAD").trim();
    const result = run("scripts/wiki-replay.ts", repo, first, added, "--out", out, "--dry-run");
    expect(result.status).toBe(0);
    const rows = result.stdout.split("\n").filter((line) => /^\| \d/.test(line));
    expect(rows).toHaveLength(3);
    // The last step touches no page and the article is priced only on the first, so its cost is
    // the tie-break call alone.
    expect(rows[2]).toMatch(/\| 1 \| 0 \| \$(?!0\.0000)\d+\.\d{4} \|$/);
    expect(rows[1]).toMatch(/\| 1 \| 1 \| \$\d+\.\d{4} \|$/);
  });

  it("reports an unexpected error as one line, exits 1, frees its lock and records the stop", () => {
    const { repo, out, first, quiet } = replayable();
    corruptPages(out);
    const result = run("scripts/wiki-replay.ts", repo, first, quiet, "--out", out);
    expectOneLineFailure(result);
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
    const summary = readFileSync(
      join(out, `replay-${first.slice(0, 7)}-${quiet.slice(0, 7)}.md`),
      "utf8",
    );
    expect(summary).toContain(`Stopped at step 1 (${quiet.slice(0, 7)}): `);
  });

  it("refuses up front, with the head unmoved, a step whose only call is the due About article", () => {
    // Two pages and no article: the About article is due, and it is the step's only call.
    const { repo, out, first, quiet } = replayable(null, { paged: true });
    const result = run("scripts/wiki-replay.ts", repo, first, quiet, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY is not set");
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
    const store = openStore(join(out, "wiki.db"));
    expect(store.getHead()).toBe(first);
    store.close();
    // The step was not half-applied, so a rerun still has it to do.
    const again = run("scripts/wiki-replay.ts", repo, first, quiet, "--out", out, "--dry-run");
    expect(again.stdout.split("\n").filter((line) => /^\| \d/.test(line))).toHaveLength(1);
  });

  /** The step rows of a replay summary: their numbers and short shas. */
  const summaryRows = (text: string) =>
    text
      .split("\n")
      .filter((line) => /^\| \d/.test(line))
      .map((row) => row.split(" | ").slice(0, 2));

  it("keeps every run's rows when --limit replays the range in pieces", () => {
    const { repo, out, first, quiet, quiet2 } = replayable(null, { twoQuiet: true });
    const summaryPath = join(out, `replay-${first.slice(0, 7)}-${(quiet2 ?? "").slice(0, 7)}.md`);
    const one = run(
      "scripts/wiki-replay.ts",
      repo,
      first,
      quiet2 ?? "",
      "--out",
      out,
      "--limit",
      "1",
    );
    expect(one.status).toBe(0);
    expect(summaryRows(readFileSync(summaryPath, "utf8"))).toEqual([["| 1", quiet.slice(0, 7)]]);
    expect(readFileSync(summaryPath, "utf8")).toContain("1 steps replayed, 1 left");
    const two = run(
      "scripts/wiki-replay.ts",
      repo,
      first,
      quiet2 ?? "",
      "--out",
      out,
      "--limit",
      "1",
    );
    expect(two.status).toBe(0);
    for (const text of [readFileSync(summaryPath, "utf8"), two.stdout]) {
      expect(summaryRows(text)).toEqual([
        ["| 1", quiet.slice(0, 7)],
        ["| 2", (quiet2 ?? "").slice(0, 7)],
      ]);
      expect(text).toContain("2 steps replayed;");
      // Both steps' verdicts, and the gate's line, now that nothing is left.
      expect(text.split("\n").filter((line) => /\| 0 \| n\/a \|$/.test(line))).toHaveLength(2);
      expect(text).toContain("Invariants: no step left a problem; token invariant not checked");
    }
    expect(
      existsSync(join(out, `replay-${first.slice(0, 7)}-${(quiet2 ?? "").slice(0, 7)}.json`)),
    ).toBe(true);
    expect(readdirSync(out).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("prints the gate's line when a build was there to compare and every step held", () => {
    const { repo, out, first, quiet } = replayable();
    // A wiki:build run in the ledger, larger than any update.
    const store = openStore(join(out, "wiki.db"));
    store.appendLedger({
      runId: `wiki-build-${first}-2026-10-03T00:00:00.000Z`,
      at: "2026-10-03T00:00:00.000Z",
      purpose: "write",
      model: "claude-haiku-4-5",
      featureId: null,
      batch: true,
      cacheKey: null,
      tokens: { in: 100_000, out: 5_000, cacheRead: 0, cacheWrite: 0 },
      runKind: "build",
      sha: first,
    });
    store.close();
    const result = run("scripts/wiki-replay.ts", repo, first, quiet, "--out", out);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Invariants: hold for every step.");
  });

  it("exits 1 when a step leaves a problem, and says the invariants broke", () => {
    const { repo, out, first, quiet } = replayable("c-\u202e1\u0007");
    const result = run("scripts/wiki-replay.ts", repo, first, quiet, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Invariants: **broken**");
  });

  it("records the step it stopped at and why, in a printable line", () => {
    const { repo, out, first, quiet, loud } = replayable();
    const result = run("scripts/wiki-replay.ts", repo, first, loud, "--out", out);
    expect(result.status).toBe(1);
    const summary = readFileSync(
      join(out, `replay-${first.slice(0, 7)}-${loud.slice(0, 7)}.md`),
      "utf8",
    );
    const line = summary.split("\n").find((l) => l.startsWith("Stopped at step 2")) ?? "";
    expect(line).toMatch(
      new RegExp(`^Stopped at step 2 \\(${loud.slice(0, 7)}\\): .*ANTHROPIC_API_KEY is not set`),
    );
    expect(line).toMatch(/^[\x20-\x7e]+$/);
    expect(summaryRows(summary)).toEqual([["| 1", quiet.slice(0, 7)]]);
    // The export follows the store to the step it stored, though the run stopped after it.
    const exported = JSON.parse(readFileSync(join(out, "export.json"), "utf8"));
    expect(exported.head).toBe(quiet);
  });

  it("leaves a record even when the run stops at its very first step", () => {
    const { repo, out, first, quiet } = replayable(null, { paged: true });
    const result = run("scripts/wiki-replay.ts", repo, first, quiet, "--out", out);
    expect(result.status).toBe(1);
    const summary = readFileSync(
      join(out, `replay-${first.slice(0, 7)}-${quiet.slice(0, 7)}.md`),
      "utf8",
    );
    expect(summary).toContain("0 steps replayed, 1 left");
    expect(summary).toContain(`Stopped at step 1 (${quiet.slice(0, 7)}): `);
    expect(summary).not.toContain("hold for every step");
  });

  it("checks and records a step an earlier run stored but never recorded, then continues", () => {
    const { repo, out, first, quiet, quiet2 } = replayable(null, { twoQuiet: true });
    const target = quiet2 ?? "";
    // A run killed after storing `quiet`: the head is there, and no replay record exists.
    const moved = run("scripts/wiki-update.ts", repo, quiet, "--out", out);
    expect(moved.status).toBe(0);
    rmSync(join(out, "export.json"), { force: true });
    const result = run("scripts/wiki-replay.ts", repo, first, target, "--out", out);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`${quiet.slice(0, 7)}: stored by a run that stopped`);
    const summary = readFileSync(
      join(out, `replay-${first.slice(0, 7)}-${target.slice(0, 7)}.md`),
      "utf8",
    );
    expect(summaryRows(summary)).toEqual([
      ["| 1", quiet.slice(0, 7)],
      ["| 2", target.slice(0, 7)],
    ]);
    expect(summary).toMatch(/\| 1 \| [0-9a-f]{7} \| 4 \| [^|]+ \| n\/a \| n\/a \| n\/a \|/);
    expect(existsSync(join(out, "export.json"))).toBe(true);
  });

  it("keeps the earlier records when the wiki's head is a commit between steps", () => {
    const { repo, out, first, quiet, git } = replayable();
    // Off `quiet`: a direct commit (no step), then a merge with no net change (a step).
    git("switch", "-q", "-c", "alt", quiet);
    git("commit", "-q", "--allow-empty", "-m", "chore: direct");
    const direct = git("rev-parse", "HEAD").trim();
    git("switch", "-q", "-c", "scratch3");
    writeFileSync(join(repo, "scratch3.txt"), "tmp\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add scratch3");
    git("rm", "-q", "scratch3.txt");
    git("commit", "-q", "-m", "remove scratch3");
    git("switch", "-q", "alt");
    git("merge", "-q", "--no-ff", "-m", "Merge pull request #9 from me/scratch3", "scratch3");
    const last = git("rev-parse", "HEAD").trim();
    const summaryPath = join(out, `replay-${first.slice(0, 7)}-${last.slice(0, 7)}.md`);

    expect(
      run("scripts/wiki-replay.ts", repo, first, last, "--out", out, "--limit", "1").status,
    ).toBe(0);
    expect(run("scripts/wiki-update.ts", repo, direct, "--out", out).status).toBe(0);
    const result = run("scripts/wiki-replay.ts", repo, first, last, "--out", out);
    expect(result.status).toBe(0);
    expect(summaryRows(readFileSync(summaryPath, "utf8"))).toEqual([
      ["| 1", quiet.slice(0, 7)],
      ["| 2", last.slice(0, 7)],
    ]);
  });

  it("checks and records every step stored without a record, not only the head's", () => {
    const { repo, out, first, quiet, quiet2 } = replayable(null, { twoQuiet: true });
    const target = quiet2 ?? "";
    // Two steps moved by wiki:update, neither recorded by a replay.
    expect(run("scripts/wiki-update.ts", repo, quiet, "--out", out).status).toBe(0);
    expect(run("scripts/wiki-update.ts", repo, target, "--out", out).status).toBe(0);
    const result = run("scripts/wiki-replay.ts", repo, first, target, "--out", out);
    expect(result.status).toBe(0);
    for (const sha of [quiet, target])
      expect(result.stderr).toContain(`${sha.slice(0, 7)}: stored by a run that stopped`);
    const summary = readFileSync(
      join(out, `replay-${first.slice(0, 7)}-${target.slice(0, 7)}.md`),
      "utf8",
    );
    expect(summaryRows(summary)).toEqual([
      ["| 1", quiet.slice(0, 7)],
      ["| 2", target.slice(0, 7)],
    ]);
  });

  it("records an unrecorded last step and rewrites the export when nothing is left", () => {
    const { repo, out, first, quiet } = replayable();
    run("scripts/wiki-update.ts", repo, quiet, "--out", out);
    rmSync(join(out, "export.json"), { force: true });
    const result = run("scripts/wiki-replay.ts", repo, first, quiet, "--out", out);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`the wiki is already at ${quiet}; nothing to replay`);
    expect(existsSync(join(out, "export.json"))).toBe(true);
    const summary = readFileSync(
      join(out, `replay-${first.slice(0, 7)}-${quiet.slice(0, 7)}.md`),
      "utf8",
    );
    expect(summaryRows(summary)).toEqual([["| 1", quiet.slice(0, 7)]]);
  });

  it("refuses a range the wiki's head is not on, in one line", () => {
    const { repo, out, first, loud } = replayable();
    const result = run("scripts/wiki-replay.ts", repo, loud, loud, "--out", out, "--dry-run");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `the wiki is at ${first}, which is not on the way from ${loud} to ${loud}\n`,
    );
  });
});

describe("wiki-export.ts as a process (no network)", () => {
  it("writes export.json and llms.txt from the store with no key, and frees its lock", () => {
    const { repo, sha } = gitRepo();
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(makeManifest({ sha }), { llmRevised: true });
    store.putRevision(makeRevision({ sha, seeAlso: [] }));
    store.setHead(sha);
    store.close();
    const result = run("scripts/wiki-export.ts", repo, "--out", out);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`Wrote ${join(out, "export.json")} and ${join(out, "llms.txt")}\n`);
    expect(JSON.parse(readFileSync(join(out, "export.json"), "utf8")).repo).toBe("repo");
    expect(readFileSync(join(out, "llms.txt"), "utf8")).toMatch(
      /^# repo wiki\n[\s\S]*- \[Signal ingestion\]\(wiki\/signals\/\): /,
    );
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
  });

  it("is a usage error, exit 2, for missing or extra arguments", () => {
    for (const args of [
      [],
      ["repo", "--out"],
      ["repo", "--outdir", "x"],
      ["a", "--out", "o", "b"],
    ]) {
      const result = run("scripts/wiki-export.ts", ...args);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("usage: pnpm wiki:export <repo-path> [--out dir]\n");
    }
  });

  it("refuses an out dir inside the repository, and a store with no wiki", () => {
    const { repo } = gitRepo();
    const inside = run("scripts/wiki-export.ts", repo, "--out", join(repo, "wiki"));
    expect(inside.status).toBe(2);
    expect(inside.stderr).toContain("refusing to write inside the documented repository");
    const out = join(dir, "empty");
    const missing = run("scripts/wiki-export.ts", repo, "--out", out);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe(`no wiki at ${join(out, "wiki.db")}; run pnpm wiki:build first\n`);
    expect(existsSync(join(repo, "wiki"))).toBe(false);
  });
});
