import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "@repowiki/core";
import {
  bodyClaim,
  codeCitation,
  leadClaim,
  makeManifest,
  makeRevision,
} from "@repowiki/core/test-fixtures";
import { openStore, type Store, UpdateArticleError } from "@repowiki/engine";
import { DEFAULT_MODELS, type Provider } from "@repowiki/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseUpdateArgs } from "./update-cli.ts";
import { readInput, runUpdate, writeUpdateOutputs } from "./update-run.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "repowiki-run-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A repository with two features' files, its first commit, and git run in it. */
function twoFeatureRepo() {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(repo, "src", "other.ts"), "export const other = 1;\n");
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
  return { repo, first: git("rev-parse", "HEAD").trim(), git };
}

/** A store with a page for each feature at `sha` and no About article, which is then due. */
function storeAt(path: string, sha: string): Store {
  const store = openStore(path);
  store.putManifest(
    makeManifest({
      sha,
      membership: {
        "src/app.ts": { featureId: "signals", weight: 1 },
        "src/app.ts#app": { featureId: "signals", weight: 1 },
        "src/other.ts": { featureId: "deliverables", weight: 1 },
        "src/other.ts#other": { featureId: "deliverables", weight: 1 },
      },
    }),
    { llmRevised: true },
  );
  const page = (featureId: string, path: string, text: string) =>
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
                  contentHash: contentHash(text),
                }),
              ],
            }),
          ],
        },
      ],
    });
  store.putRevision(page("signals", "src/app.ts", "export const app = 1;\n"));
  store.putRevision(page("deliverables", "src/other.ts", "export const other = 1;\n"));
  store.setHead(sha);
  return store;
}

/** Answers every call (only the About article's is made) with a draft the two pages verify. */
const articleOnly: Provider = {
  async generate(request) {
    const draft = {
      sections: [
        {
          key: "lead",
          claims: [
            {
              id: "l1",
              text: "**repo** is built from [[signals]] and [[deliverables]].",
              cite: [],
              pages: [],
              supports: ["y1"],
            },
          ],
        },
        {
          key: "layers",
          claims: [
            {
              id: "y1",
              text: "Deliverables and signal ingestion sit side by side.",
              cite: [],
              pages: ["deliverables", "signals"],
              supports: [],
            },
          ],
        },
      ],
    };
    return {
      output: request.schema.parse(draft),
      usage: { in: 100, out: 10, cacheRead: 0, cacheWrite: 0 },
      model: "claude-haiku-4-5",
    };
  },
};

describe("runUpdate and writeUpdateOutputs", () => {
  it("hand over an update whose article could not be stored, and still write its export and summary", async () => {
    const { repo, first, git } = twoFeatureRepo();
    const out = join(dir, "o");
    mkdirSync(out);
    const store = storeAt(join(out, "wiki.db"), first);
    git("commit", "-q", "--allow-empty", "-m", "chore: nothing");
    const later = git("rev-parse", "HEAD").trim();
    const failing: Store = {
      ...store,
      putArchitecture: () => {
        throw new Error("disk I/O error");
      },
    };
    try {
      const args = parseUpdateArgs([repo, later]);
      const ran = await runUpdate(
        failing,
        await readInput(repo, later),
        args,
        DEFAULT_MODELS,
        "repo",
        () => {},
        "wiki:update",
        articleOnly,
      );
      expect(ran.articleError).toBeInstanceOf(UpdateArticleError);
      expect(ran.update.to).toBe(later);
      expect(store.getHead()).toBe(later);
      const { exportPath, summaryPath } = writeUpdateOutputs(store, out, "repo", ran, null);
      expect(JSON.parse(readFileSync(exportPath, "utf8")).head).toBe(later);
      expect(existsSync(summaryPath)).toBe(true);
      expect(summaryPath).toBe(join(out, `update-${later.slice(0, 7)}.md`));
    } finally {
      store.close();
    }
  });
});
