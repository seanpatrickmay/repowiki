import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
   * gitRepo's repository with a second commit that edits the line the stored page cites, and a
   * store under `out` whose wiki is at the first commit.
   */
  function updatable(): { repo: string; out: string; first: string; second: string } {
    const { repo, sha, git } = gitRepo();
    const out = join(dir, "o");
    mkdirSync(out);
    const store = openStore(join(out, "wiki.db"));
    store.putManifest(
      makeManifest({
        sha,
        membership: { "src/app.ts": { featureId: "signals", weight: 1 } },
      }),
      { llmRevised: true },
    );
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
        seeAlso: [],
        sections: [
          { key: "lead", claims: [leadClaim()] },
          { key: "overview", claims: [bodyClaim({ citations: [code] })] },
        ],
      }),
    );
    store.setHead(sha);
    store.close();
    writeFileSync(join(repo, "src", "app.ts"), "export const app = 2;\n");
    git("commit", "-q", "-am", "Merge pull request #3 from me/app");
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

  it("names the missing key, stores nothing and frees its lock", () => {
    const { repo, out, first, second } = updatable();
    const result = run("scripts/wiki-update.ts", repo, second, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY is not set");
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
    const store = openStore(join(out, "wiki.db"));
    expect(store.getHead()).toBe(first);
    store.close();
  });
});
