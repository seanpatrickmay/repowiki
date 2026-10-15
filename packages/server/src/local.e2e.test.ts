import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiExport } from "@repowiki/core";
import { makePeopleSnapshot } from "@repowiki/core/test-fixtures";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.ts";
import { LocalProfile } from "./github/profile.ts";
import { adaProfile, writeProfile } from "./github/test-profile.ts";
import { freePort } from "./routes/test-app.ts";
import { browser, field, sleep } from "./test-browser.ts";
import { type RunningServer, startServer } from "./wiring.ts";

/** A made-up user's local wiki for `ada/engine`, with People naming her Ada Lovelace. */
function localSetup() {
  const exp = WikiExport.parse({
    ...fixtureExport(),
    repo: "engine",
    people: { snapshot: makePeopleSnapshot({ sha: fixtureExport().head }), pages: [] },
  });
  const exports = mkdtempSync(join(tmpdir(), "repowiki-exports-"));
  const path = join(exports, "export.json");
  writeFileSync(path, JSON.stringify(exp));
  const base = adaProfile(path);
  const [engine, empty] = base.repos;
  if (engine === undefined || empty === undefined) throw new Error("adaProfile changed");
  const notes = {
    ...empty,
    repo: { ...empty.repo, id: 8003, name: "notes", full_name: "ada/notes" },
  };
  const profile = LocalProfile.parse({
    ...base,
    repos: [
      { ...engine, head: exp.head },
      { ...notes, commits: 2, head: "d".repeat(40) },
    ],
  });
  return {
    profile: writeProfile(profile),
    dataDir: mkdtempSync(join(tmpdir(), "repowiki-local-")),
  };
}

const CONTRIBUTION = "wrote 4 of the repository&#39;s 9 commits";
let server: RunningServer | null = null;
const logs: object[] = [];
afterAll(async () => server?.close());

/** The app's and the public pages' origins: two hosts on one port (ADR-0012). */
async function start(env: Record<string, string>): Promise<{ base: string; pages: string }> {
  const config = loadConfig(env);
  server = await startServer(config, { log: (line) => logs.push(line) });
  return { base: config.appOrigin, pages: config.publicOrigin };
}

async function waitFor(me: ReturnType<typeof browser>, path: string, text: string) {
  let page = await me.go(path);
  for (let i = 0; i < 120 && !page.text.includes(text); i++) {
    await sleep(500);
    page = await me.go(path);
  }
  expect(page.text, JSON.stringify(logs.filter((l) => "worker" in l))).toContain(text);
  return page;
}

describe("local profile mode (M14g)", () => {
  it("builds a project from the local wiki, publishes it, and keeps it across a restart", async () => {
    const { profile, dataDir } = localSetup();
    const env = {
      REPOWIKI_MODE: "development",
      PORT: String(await freePort()),
      DATA_DIR: dataDir,
      REPOWIKI_PROFILE: profile,
      REPOWIKI_LOCAL_PLAN: "pro",
    };
    let { base, pages } = await start(env);
    const me = browser(base);
    const dashboard = await me.follow("/auth/github");
    expect(dashboard.status, JSON.stringify(logs.slice(-5))).toBe(200);
    expect(dashboard.text).toContain("ada/engine");
    expect(dashboard.text).toContain("ada/notes");
    const csrf = field(dashboard.text, "csrf");

    const created = await me.go("/projects", { form: { csrf, githubRepoId: "8001" } });
    expect(created.status, created.text).toBe(303);
    const projectPath = created.location ?? "";
    let page = await waitFor(me, projectPath, "Portfolio (revision 1)");
    const reviewed = await me.go(`${projectPath}/review`, {
      form: { csrf, revision: "1", attest: "yes" },
    });
    expect(reviewed.status, reviewed.text).toBe(303);
    expect((await me.go(`${projectPath}/preview`, { form: { csrf, revision: "1" } })).status).toBe(
      303,
    );
    page = await me.go(projectPath);
    const published = await me.go(`${projectPath}/publish`, {
      form: {
        csrf,
        revision: "1",
        expectedVersion: field(page.text, "expectedVersion"),
        previewHash: field(page.text, "previewHash"),
      },
    });
    expect(published.status, published.text).toBe(303);

    const reader = browser(pages);
    const bio = await reader.go("/ada");
    expect(bio.status).toBe(200);
    expect(bio.text).toContain('<td>Python</td><td class="num">73%</td>');
    expect(bio.text).toContain('<td class="num">4</td>');
    // No model in import mode: the contribution is the facts paragraph (ADR-0012).
    expect(bio.text).toContain(CONTRIBUTION);
    expect((await reader.go("/ada/engine/")).status).toBe(200);

    // A second project (Pro) for a repository with no local wiki fails, saying why in the log.
    const second = await me.go("/projects", { form: { csrf, githubRepoId: "8003" } });
    expect(second.status, second.text).toBe(303);
    await waitFor(me, second.location ?? "", "Generation: failed");
    // The worker's stderr is logged when it exits, which can be a moment after the job failed.
    await vi.waitFor(() => expect(JSON.stringify(logs)).toContain("no local wiki for ada/notes"), {
      timeout: 15_000,
      interval: 250,
    });

    await server?.close();
    server = null;
    ({ base, pages } = await start(env));
    const back = browser(pages);
    expect((await back.go("/ada")).text).toContain(CONTRIBUTION);
    const again = await me.go(`${base}/dashboard`);
    expect(again.status).toBe(200);
    expect(again.text).toContain("ada/engine");
  }, 300_000);
});
