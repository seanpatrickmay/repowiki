import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BiographyEntry, type Suggestions } from "@repowiki/hosted";
import { fixtureExport } from "@repowiki/site/test-fixtures";
import { createApp, type Deps } from "../app.ts";
import { loadConfig } from "../config.ts";
import type { Db } from "../db/db.ts";
import { fakeEndpoints } from "../github/endpoints.ts";
import { FAKE_REPO, FAKE_TOKEN, FAKE_USER, fakeGitHubFetch } from "../github/fake.ts";
import { HttpError } from "../http/body.ts";
import type { Method, Reply, RouteRequest } from "../http/router.ts";
import { type App, text } from "../http/server.ts";
import { fsObjectStore } from "../objects/fs-store.ts";
import { fakeAnthropicFetch } from "../proxy/fake-anthropic.ts";
import { recordingRunner } from "../runner/runner.ts";
import { signIn } from "../store/accounts.ts";
import { latestRevision, saveRevision, saveVersion } from "../store/drafts.ts";
import { saveGitHubToken } from "../store/github-tokens.ts";
import { projectById, saveProject } from "../store/projects.ts";
import { createSession } from "../store/sessions.ts";
import { freshDb } from "../store/test-db.ts";
import { internalRoutes } from "./internal.ts";
import { projectRoutes } from "./projects.ts";

export const TEST_NOW = "2026-10-14T12:00:00.000Z";

/** Test-only: demo-mode dependencies over a fresh database, with a fixed clock and ids. */
export async function testDeps(overrides: Partial<Deps> = {}): Promise<Deps & { db: Db }> {
  const config = loadConfig({ REPOWIKI_MODE: "demo" });
  const github = fakeEndpoints(config.appOrigin);
  let n = 0;
  return {
    config,
    db: await freshDb(),
    fetch: fakeGitHubFetch(github),
    github,
    now: () => TEST_NOW,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    runner: recordingRunner().runner,
    objects: fsObjectStore(mkdtempSync(join(tmpdir(), "repowiki-objects-"))),
    anthropic: { url: "https://api.anthropic.test", key: null, fetch: fakeAnthropicFetch().fetch },
    stripe: null,
    log: () => undefined,
    ...overrides,
  };
}

/** Test-only: one request to `app` without a socket; path and errors handled as `listen` does. */
export async function call(
  app: App,
  init: { method?: Method; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  const headers = Object.fromEntries(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const method = init.method ?? "GET";
  const raw = Object.assign(
    Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]),
    { headers, method },
  ) as unknown as RouteRequest["raw"];
  const at = init.path.indexOf("?");
  const request = app({
    method,
    path: at === -1 ? init.path : init.path.slice(0, at),
    params: {},
    query: new URLSearchParams(at === -1 ? "" : init.path.slice(at + 1)),
    headers,
    raw,
  });
  // As `listen` does: an HttpError is the client's answer.
  return request.catch((e: unknown) => {
    if (e instanceof HttpError) return text(e.status, e.message);
    throw e;
  });
}

/** Test-only: the value a reply's Set-Cookie gives `name`, or undefined. */
export function setCookie(reply: Reply, name: string): string | undefined {
  const value = reply.headers?.["set-cookie"];
  const all = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const found = all.find((c) => c.startsWith(`${name}=`));
  return found === undefined
    ? undefined
    : decodeURIComponent(found.slice(name.length + 1).split(";")[0] ?? "");
}

/** Test-only: the fake GitHub user signed in with their token stored; a cookie and CSRF token. */
export async function signedInCookie(
  deps: Deps,
): Promise<{ cookie: string; csrf: string; accountId: string }> {
  const signed = await signIn(
    deps.db,
    {
      githubUserId: FAKE_USER.id,
      login: FAKE_USER.login,
      displayName: FAKE_USER.name,
      githubCreatedAt: FAKE_USER.created_at,
    },
    { newAccountId: deps.newId(), allowNew: () => true, now: deps.now() },
  );
  if (signed === null) throw new Error("sign-in refused");
  const { id } = signed.account;
  await deps.db.transaction((tx) => saveGitHubToken(tx, deps.config.tokenKey, id, FAKE_TOKEN));
  const session = await createSession(deps.db, id, deps.now());
  return { cookie: `session=${session.token}`, csrf: session.csrf, accountId: id };
}

/** Test-only: the headers of a same-origin form post. */
export function form(cookie: string, origin: string): Record<string, string> {
  return { cookie, origin, "content-type": "application/x-www-form-urlencoded" };
}

/** Test-only: a signed-in user who started a generation through `POST /projects`; its first token. */
export async function startedJob(
  deps: Deps,
): Promise<{ jobId: string; token: string; projectId: string }> {
  const recording = recordingRunner();
  const local = { ...deps, runner: recording.runner };
  const { cookie, csrf } = await signedInCookie(local);
  const reply = await call(createApp(local, projectRoutes(local)), {
    method: "POST",
    path: "/projects",
    headers: form(cookie, deps.config.appOrigin),
    body: `csrf=${csrf}&githubRepoId=${FAKE_REPO.id}`,
  });
  const projectId = String(reply.headers?.location).split("/").at(-1) ?? "";
  const start = recording.started[0];
  if (start === undefined) throw new Error("no job started");
  return { jobId: start.jobId, token: start.token, projectId };
}

/** Test-only: the fixture export's feature ids, in page order. */
export const FIXTURE_FEATURES = [...new Set(fixtureExport().pages.map((p) => p.featureId))];

/** Test-only: a project whose first generation succeeded, so revision 1 exists; its owner signed in. */
export async function generatedProject(
  deps: Deps,
  suggested: Partial<Suggestions> = {},
): Promise<{ projectId: string; jobId: string; cookie: string; csrf: string; accountId: string }> {
  const job = await startedJob(deps);
  const app = createApp(deps, internalRoutes(deps));
  const auth = { authorization: `Bearer ${job.token}` };
  const json = { ...auth, "content-type": "application/json" };
  await call(app, { method: "POST", path: "/internal/job/lease", headers: auth });
  const body = JSON.stringify(fixtureExport());
  await call(app, { method: "PUT", path: "/internal/job/export", headers: json, body });
  const done = await call(app, {
    method: "POST",
    path: "/internal/job/succeed",
    headers: json,
    body: JSON.stringify({
      suggestions: {
        tagline: "A tiny demo",
        summary: "It demonstrates RepoWiki.",
        contributionDraft: "I wrote the ingest code.",
        highlightCandidates: FIXTURE_FEATURES.slice(0, 1),
        ...suggested,
      },
      facts: {
        languages: [{ name: "Python", share: 1 }],
        indexedFiles: 3,
        featureIds: FIXTURE_FEATURES,
        author: { commits: 2, totalCommits: 3, currentLines: 10, totalLines: 20, features: [] },
      },
      engineVersion: "test",
      models: ["claude-haiku-4-5"],
    }),
  });
  if (done.status !== 204) throw new Error(`succeed answered ${done.status}`);
  const { cookie, csrf, accountId } = await signedInCookie(deps);
  return { projectId: job.projectId, jobId: job.jobId, cookie, csrf, accountId };
}

/** Test-only: as if a refresh landed: the next revision, with the latest one's content. */
export async function refreshed(deps: Deps, projectId: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const project = await projectById(tx, projectId, true);
    const latest = await latestRevision(tx, projectId);
    if (project === null || latest === null) throw new Error("no revision to refresh");
    const number = latest.number + 1;
    await saveRevision(tx, { ...latest, number, createdAt: deps.now() });
    await saveProject(tx, { ...project, latestRevision: number });
  });
}

/** Test-only: a second GitHub user with an account and a session, who owns nothing. */
export async function otherCookie(deps: Deps): Promise<{ cookie: string; csrf: string }> {
  const signed = await signIn(
    deps.db,
    {
      githubUserId: 990_001,
      login: "someone-else",
      displayName: "Someone Else",
      githubCreatedAt: FAKE_USER.created_at,
    },
    { newAccountId: deps.newId(), allowNew: () => true, now: deps.now() },
  );
  if (signed === null) throw new Error("sign-in refused");
  const session = await createSession(deps.db, signed.account.id, deps.now());
  return { cookie: `session=${session.token}`, csrf: session.csrf };
}

/** Test-only: a loopback port nothing listens on (amendment A2: the config refuses port 0). */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return address.port;
}

/** Test-only: the outcomes audited for `action` on a project, oldest first. */
export async function auditOutcomes(db: Db, action: string, projectId: string): Promise<string[]> {
  const rows = await db.query<{
    body: { action: string; outcome: string; target: { id: string } };
  }>("SELECT body FROM audit_events ORDER BY created_at, id");
  return rows
    .map((r) => r.body)
    .filter((b) => b.action === action && b.target.id === projectId)
    .map((b) => b.outcome);
}

/**
 * Test-only: another published project of `accountId`, with a version and its biography entry
 * stored but no built site (enough for a biography, not for its wiki). Returns its id.
 */
export async function publishedStub(
  deps: Deps,
  accountId: string,
  slug: string,
  githubRepoId: number,
): Promise<string> {
  const id = deps.newId();
  const now = deps.now();
  await saveProject(deps.db, {
    id,
    accountId,
    githubRepoId,
    slug,
    state: "published",
    withdrawReason: null,
    withdrawnAt: null,
    unavailableSince: null,
    latestRevision: 1,
    currentVersion: 1,
    createdAt: now,
  });
  const siteKey = `sites/${id}/v1/`;
  await saveVersion(deps.db, {
    projectId: id,
    version: 1,
    revision: 1,
    siteKey,
    siteHash: "a".repeat(64),
    authorization: {
      checkedAt: now,
      githubUserId: FAKE_USER.id,
      githubRepoId,
      fullName: `demo-dev/${slug}`,
      visibility: "public",
      isFork: false,
      permission: "admin",
      authoredCommits: 3,
      indexedFiles: 2,
      tokenValid: true,
    },
    publishedAt: now,
  });
  const entry = stubEntry(slug, `demo-dev/${slug}`);
  await deps.objects.put(`${siteKey}entry.json`, JSON.stringify(entry), "application/json");
  return id;
}

/** Test-only: the biography entry of a made-up project at `fullName`. */
export function stubEntry(slug: string, fullName: string): BiographyEntry {
  return BiographyEntry.parse({
    title: `Stub ${slug}`,
    repo: { fullName, commitSha: "f".repeat(40) },
    firstCommitAt: "2025-01-01T00:00:00Z",
    lastCommitAt: "2025-06-01T00:00:00Z",
    articles: 2,
    lead: `Stub ${slug} is a made-up project.`,
    contribution: "Developer wrote 3 of the repository's 3 commits.",
    facts: {
      languages: [{ name: "Go", share: 1 }],
      indexedFiles: 2,
      featureIds: [],
      author: { commits: 3, totalCommits: 3, currentLines: 5, totalLines: 5, features: [] },
    },
  });
}
