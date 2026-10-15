import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiExport } from "@repowiki/core";
import { makePeopleSnapshot } from "@repowiki/core/test-fixtures";
import { Facts } from "@repowiki/hosted";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import type { FailCode, Succeeded, WorkerApi, WorkerSpec } from "./api.ts";
import { exportFacts, matchAuthor, runImport } from "./import.ts";

const ADA = { login: "ada", name: "Ada Lovelace" };
const peopleExport = () =>
  WikiExport.parse({
    ...fixtureExport(),
    repo: "engine",
    people: { snapshot: makePeopleSnapshot({ sha: fixtureExport().head }), pages: [] },
  });

describe("exportFacts", () => {
  it("takes languages and size from the page infoboxes and the author's share from People", () => {
    const facts = exportFacts(peopleExport(), ADA);
    expect(Facts.parse(facts)).toEqual(facts);
    expect(facts.indexedFiles).toBe(15);
    expect(facts.languages).toEqual([
      { name: "Python", share: 0.731 },
      { name: "TypeScript", share: 0.268 },
    ]);
    expect(facts.author).toEqual({
      commits: 4,
      totalCommits: 9,
      currentLines: 90,
      totalLines: 240,
      features: [
        { featureId: "signals", commits: 3, currentLines: 80 },
        { featureId: "deliverables", commits: 1, currentLines: 10 },
      ],
    });
  });

  it("gives zeros when People does not name the author, or there is no People", () => {
    const zeros = { commits: 0, currentLines: 0, features: [] };
    expect(exportFacts(peopleExport(), { login: "nobody", name: null }).author).toMatchObject({
      ...zeros,
      totalCommits: 9,
    });
    expect(exportFacts(WikiExport.parse(fixtureExport()), ADA).author).toMatchObject(zeros);
  });
});

describe("matchAuthor", () => {
  const snapshot = makePeopleSnapshot();
  it("matches the login, the display name or another name, ignoring case and spacing", () => {
    for (const author of [
      { login: "ADA", name: null },
      { login: "someone", name: "ada lovelace" },
      { login: "ada-lovelace", name: null },
      { login: "x", name: "Grace  Hopper" },
    ]) {
      expect(matchAuthor(snapshot, author)?.kind, JSON.stringify(author)).toBe("human");
    }
    expect(matchAuthor(snapshot, { login: "x", name: "Grace Hopper" })?.id).toBe("grace-hopper");
  });

  it("never takes a bot's numbers or guesses between two people", () => {
    expect(matchAuthor(snapshot, { login: "dependabot", name: null })).toBeNull();
    expect(matchAuthor(snapshot, { login: "ada", name: "Grace Hopper" })?.id).toBe("ada-lovelace");
    expect(matchAuthor(snapshot, { login: "zed", name: "Grace Hopper" })?.id).toBe("grace-hopper");
    const twins = makePeopleSnapshot({
      people: snapshot.people.map((p) => (p.id === "grace-hopper" ? { ...p, name: "Ada" } : p)),
    });
    expect(matchAuthor(twins, { login: "zed", name: "Ada" })).toBeNull();
  });
});

/** A fake internal API: one lease for `ada/engine` at `sha`, recording every call. */
function fakeApi(sha: string) {
  const calls: string[] = [];
  let succeeded: Succeeded | null = null;
  let failed: FailCode | null = null;
  let uploaded: Uint8Array | null = null;
  const spec: WorkerSpec = {
    jobId: "job-1",
    attempt: 1,
    kind: "generate",
    commitSha: sha,
    repo: {
      fullName: "ada/engine",
      name: "engine",
      cloneUrl: "https://github.com/ada/engine.git",
      sizeKb: 40,
    },
    author: { login: "ada", githubUserId: 7001, commitShas: [] },
    limits: { maxIndexedFiles: 5000 },
    llmUrl: "http://127.0.0.1:1/llm",
  };
  const api: WorkerApi = {
    async lease() {
      calls.push("lease");
      return spec;
    },
    async heartbeat(step) {
      calls.push(step);
    },
    async indexed() {
      calls.push("indexed");
      return "ok";
    },
    async putExport(bytes) {
      uploaded = bytes;
    },
    async succeed(body) {
      succeeded = body;
    },
    async fail(code) {
      failed = code;
    },
  };
  return {
    api,
    calls,
    result: () => ({ succeeded, failed, uploaded: uploaded as Uint8Array | null }),
  };
}

const profileWith = (exportPath: string | null) => ({
  user: { login: "ada", name: "Ada Lovelace" },
  repos: [{ repo: { full_name: "ada/engine" }, export: exportPath }],
});

describe("runImport", () => {
  it("uploads the mapped export and succeeds with facts from it", async () => {
    const exp = peopleExport();
    const path = join(mkdtempSync(join(tmpdir(), "repowiki-import-")), "export.json");
    writeFileSync(path, JSON.stringify(exp));
    const fake = fakeApi(exp.head);
    expect(await runImport(fake.api, profileWith(path), { stepMs: 0 })).toBe(true);
    const { succeeded, failed, uploaded } = fake.result();
    expect(failed).toBeNull();
    expect(fake.calls.slice(0, 3)).toEqual(["lease", "fetch", "index"]);
    expect(fake.calls).toContain("indexed");
    expect(
      WikiExport.parse(JSON.parse(new TextDecoder().decode(uploaded ?? new Uint8Array()))),
    ).toEqual(exp);
    expect(Facts.parse(succeeded?.facts)).toEqual(exportFacts(exp, ADA));
    expect(succeeded?.suggestions.highlightCandidates[0]).toBe("signals");
  });

  it("fails the job when the repository has no local wiki, or it no longer matches", async () => {
    const lines: object[] = [];
    const none = fakeApi("c".repeat(40));
    const log = (line: object) => lines.push(line);
    expect(await runImport(none.api, profileWith(null), { stepMs: 0, log })).toBe(false);
    expect(none.result()).toMatchObject({ failed: "job-failed", succeeded: null, uploaded: null });
    expect(JSON.stringify(lines)).toContain(
      "no local wiki for ada/engine; build it with pnpm wiki:build",
    );

    const dir = mkdtempSync(join(tmpdir(), "repowiki-import-"));
    writeFileSync(join(dir, "bad.json"), "{");
    const broken = fakeApi("c".repeat(40));
    expect(await runImport(broken.api, profileWith(join(dir, "bad.json")), { stepMs: 0 })).toBe(
      false,
    );
    expect(broken.result().failed).toBe("job-failed");

    const good = join(dir, "export.json");
    writeFileSync(good, JSON.stringify(peopleExport()));
    const moved = fakeApi("a".repeat(40));
    expect(await runImport(moved.api, profileWith(good), { stepMs: 0 })).toBe(false);
    expect(moved.result()).toMatchObject({ failed: "job-failed", uploaded: null });
  });
});
