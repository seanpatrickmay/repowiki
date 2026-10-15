# M14g Local Profile Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm hosted:local` runs the hosted app on `127.0.0.1` as a real GitHub user (the owner, `seanpatrickmay`), with his real public repositories, building each project page from the wiki he already built locally (`~/.repowiki/<repo>/export.json`). He inspects the result and says what to change. No account, no OAuth app, no model spend.

**Architecture:** A snapshot of the user's public GitHub data (profile, repositories, their commit counts and shas, each default branch's head) is taken once by `scripts/hosted-profile.ts` and saved outside the repository, beside a map from each repository to its local export. In development mode with no OAuth app configured, the fake GitHub serves that snapshot instead of the demo user. The worker gains an `import` mode that uploads the mapped export with facts computed from it (languages and size from the page infoboxes; the author's share from the People snapshot) and suggestions made without a model. State persists across restarts under the local data directory.

**Tech Stack:** TypeScript, GitHub REST (script only), vitest.

**Owner's request (2026-10-15):** "I want you to use my own profile as the example for local testing/feedback. I will inspect it and tell you what to alter."

## Global Constraints

- The owner's data never enters the repository: the snapshot and the data directory live under `~/.repowiki/hosted-local/`. Tests use made-up profiles.
- Tests never call the network; only `scripts/hosted-profile.ts` does, when the owner (or the coordinator) runs it.
- `import` mode is allowed only outside production (`loadConfig` refuses `REPOWIKI_PROFILE` in production).
- The plan override (`REPOWIKI_LOCAL_PLAN=pro`) exists so one local user can try several projects; it is refused in production and applies only to accounts created while it is set.
- One branch per task, stacked on M14f: `m14/local-profile`, `m14/local-github`, `m14/worker-import`.

## Review Focus

1. **A repository with no local wiki**: the job fails with a clear message ("No local wiki for <repo>; build it with pnpm wiki:build") and nothing is charged.
2. **The People snapshot names the author differently** (`Sean May`, `seanpatrickmay`, an email): matched by GitHub login, display name or other names, case-insensitively; no match gives zeros, never another person's numbers.
3. **The export's head differs from GitHub's head**: the job's commit is the export's head, so citations resolve; the snapshot records both and uses the export's.
4. **Two exports for one repository** (`repowiki` and `repowiki-site`): the one with People, then more pages, wins; the choice is printed by the script.
5. **A restart**: the account, token, projects and published pages survive (`DATA_DIR` and a persisted token key).

---

### Task 1: The profile snapshot and its script

**Files:**
- Create: `packages/server/src/github/profile.ts`, `packages/server/src/github/profile.test.ts`
- Create: `scripts/hosted-profile.ts`, `scripts/hosted-profile.test.ts`
- Modify: `package.json` (root script `hosted:profile`), `packages/server/src/index.ts`

**Interfaces:**
- Produces: `LocalProfile` (zod schema/type), `takeProfile({ login, fetch, token?, exportsDir })` → `Promise<LocalProfile>`, `chooseExports(dir)` → `Map<repoNameLowercased, { path, pages, people }>`, `loadProfile(path)`.

`LocalProfile`:

```ts
export const LocalProfile = z.strictObject({
  takenAt: z.iso.datetime(),
  user: z.strictObject({ id: z.int().positive(), login: z.string().min(1), name: z.string().nullable(), created_at: z.iso.datetime() }),
  repos: z.array(
    z.strictObject({
      repo: GitHubRepo,                 // M14b's schema; permissions set to the owner's (admin/push true)
      commits: z.int().nonnegative(),   // authored by the user, capped at 1000 (M14b's countCommits rule)
      commitShas: z.array(GitSha).max(100),
      head: GitSha,                     // the export's head when one is mapped, else the default branch's
      githubHead: GitSha.nullable(),
      export: z.string().min(1).nullable(), // absolute path of the mapped export.json
    }),
  ),
});
```

- [ ] **Step 1: Branch**

```bash
git switch -c m14/local-profile
```

- [ ] **Step 2: Write the failing tests**

`packages/server/src/github/profile.test.ts` covers, with a fake `fetch` serving a made-up user `ada` with three repositories (one fork, one with a local export, one without) and two exports in a temporary directory (`ada-tool/export.json` with People and 3 pages; `ada-tool-old/export.json` naming the same repository without People):
- `takeProfile` lists only non-fork public repositories, sets `permissions` to admin, counts commits from the `Link` header, keeps at most 100 shas;
- the repository with exports maps to the People export, and its `head` is that export's head while `githubHead` is GitHub's;
- the repository without an export has `export: null` and `head === githubHead`;
- `chooseExports` prefers People, then more pages, matching `export.repo` case-insensitively to the repository name;
- the result passes `LocalProfile`.

`scripts/hosted-profile.test.ts` covers the argument parsing only (`<login>` required; `--out` default `~/.repowiki/hosted-local/<login>.json`; `--exports` default `~/.repowiki`; it refuses an `--out` inside the repository).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run packages/server/src/github/profile.test.ts scripts/hosted-profile.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 4: Write the implementation**

`takeProfile` uses M14b's `githubApi` where its methods fit (`user` needs a token; for an unauthenticated snapshot call `GET /users/<login>` and `GET /users/<login>/repos?type=owner&per_page=100` directly, adding `Authorization: Bearer $GITHUB_TOKEN` when the variable is set), `countCommits`/`commitShas` logic for commits, and `GET /repos/<full>/commits/<branch>` for `githubHead`. `chooseExports` reads every `<dir>/*/export.json` with `WikiExport.safeParse` (skipping files that fail) and keeps the best per repository name.

`scripts/hosted-profile.ts <login> [--out file] [--exports dir]` prints one line per repository (`name  commits  export-or-none`) and writes the JSON with mode 0600.

Root `package.json`: `"hosted:profile": "node scripts/hosted-profile.ts"`.

- [ ] **Step 5: Run the tests, check and commit**

```bash
pnpm format && node node_modules/vitest/vitest.mjs run packages/server scripts/hosted-profile.test.ts
pnpm check
git add packages/server scripts/hosted-profile.ts scripts/hosted-profile.test.ts package.json
git -c user.email=sean.may101@gmail.com commit -m "feat(server): snapshot a GitHub user's public repositories for local testing"
```

---

### Task 2: The fake GitHub serves a profile; persistent local state; the plan override

**Files:**
- Modify: `packages/server/src/github/fake.ts` (`profileGitHubFetch(endpoints, profile)`), `packages/server/src/github/fake.test.ts`
- Modify: `packages/server/src/config.ts` (`localProfile`, `localPlan`, persisted dev token key), `packages/server/src/config.test.ts`
- Modify: `packages/server/src/store/accounts.ts` (`signIn` takes an optional `plan` for new accounts), `packages/server/src/routes/auth.ts`, `packages/server/src/wiring.ts`
- Modify: root `package.json` (`hosted:local`)

**Interfaces:**
- Produces: `profileGitHubFetch(endpoints, profile)` — the same routes as `fakeGitHubFetch` (OAuth token exchange, `/user`, `/user/repos`, `/repositories/:id`, commit counts with a `Link` header, commit lists, the head commit) answered from the profile; `Config.localProfile: string | null` (`REPOWIKI_PROFILE`), `Config.localPlan: "free" | "pro"` (`REPOWIKI_LOCAL_PLAN`, default `free`).

Behaviour:
- `REPOWIKI_PROFILE` and `REPOWIKI_LOCAL_PLAN` are refused in production (`ConfigError`).
- In development, when `TOKEN_KEY` is unset and the data directory persists, the key is read from `<DATA_DIR>/token-key` or created there (32 random bytes, mode 0600) — tokens stored in one run decrypt in the next (this closes M14a's deferred minor).
- With a profile, the sign-up allowlist admits the profile's login automatically, and new accounts get `localPlan`.
- `hosted:local`: `REPOWIKI_MODE=development DATA_DIR=${DATA_DIR:-$HOME/.repowiki/hosted-local/data} node packages/server/src/main.ts`, reading `REPOWIKI_PROFILE` and `REPOWIKI_LOCAL_PLAN` from the environment (so the repository holds no personal login). `main.ts` prints the URL and the profile's login.

- [ ] **Step 1: Branch** — `git switch -c m14/local-github`
- [ ] **Step 2: Write the failing tests** — `fake.test.ts`: the profile's user, repositories and counts come back through M14b's real `githubApi` client; a repository not in the profile is a 404. `config.test.ts`: production refuses both variables; the dev token key persists across two `loadConfig` calls on one `DATA_DIR`. `accounts.test.ts`: a new account gets the given plan; an existing one keeps its plan.
- [ ] **Step 3: Run them to verify they fail**
- [ ] **Step 4: Implement** — as above; `wiring.ts` picks `profileGitHubFetch` when `config.localProfile` is set.
- [ ] **Step 5: Run, check and commit** — `feat(server): serve a local GitHub profile in development and keep local state across restarts`

---

### Task 3: The worker's `import` mode

**Files:**
- Create: `packages/worker/src/import.ts`, `packages/worker/src/import.test.ts`
- Modify: `packages/worker/src/main.ts` (`REPOWIKI_WORKER_MODE=import`, `REPOWIKI_PROFILE`), `packages/server/src/runner/local-runner.ts` (mode `import` and the profile path passed through), `packages/server/src/wiring.ts`
- Create: `packages/server/src/local.e2e.test.ts`

**Interfaces:**
- Consumes: M14d's `WorkerApi`, `buildFacts`'s pieces, `fallbackSuggestions`, `heartbeater`; `LocalProfile`.
- Produces: `exportFacts(exp, author: { login, name })` → `Facts`; `matchAuthor(snapshot, author)` → `PersonFacts | null`; `runImport(api, profile, options?)` → `Promise<boolean>`.

Behaviour:
- `runImport` leases, finds the profile entry whose `repo.full_name` is the spec's, walks the steps with heartbeats, and fails the job (`job-failed`, logging `no local wiki for <repo>; build it with pnpm wiki:build`) when the entry has no export or the export no longer parses.
- **Facts from the export:** `indexedFiles` is the sum of the pages' `infobox.files`. Languages are shares of the pages' `infobox.loc`, split evenly across each page's `infobox.languages` and floored to 3 decimals. `featureIds` are the pages'. The author is `matchAuthor`: the People snapshot's person whose `id`, `name` or `otherNames` equals the login or display name (case-insensitive, also comparing slugs, as in `sean-may` for `Sean May`). No match gives zeros.
- **Suggestions** are `fallbackSuggestions`. With `REPOWIKI_LOCAL_SUGGEST=model` and a configured Anthropic key, the worker makes M14d's one `suggest` call through the proxy instead; it is off by default so local runs cost nothing.
- The job's commit must equal the export's head: the fake GitHub's head commit is the profile's `head` (Task 2), so `startGeneration` records it.

- [ ] **Step 1: Branch** — `git switch -c m14/worker-import`
- [ ] **Step 2: Write the failing tests** — `import.test.ts`:
  - `exportFacts` on the site fixture export (built with a made-up People snapshot whose person is named `Ada Lovelace` with `otherNames: ["ada"]`) gives the author's commits and lines for login `ada`, display name `Ada Lovelace`;
  - a snapshot without the author gives zeros;
  - `runImport` with a fake API uploads the mapped export and succeeds with facts that pass `Facts`;
  - an entry without an export fails with `job-failed`.

  `local.e2e.test.ts` drives the journey over HTTP like M14f's e2e, in development mode with:
  - a temporary `DATA_DIR`;
  - a made-up profile file;
  - the site fixture export written to a temporary exports directory;
  - `REPOWIKI_LOCAL_PLAN=pro`.

  The journey: sign in, see the profile's repositories, build the mapped one, see "Portfolio (revision 1)" with facts from the export, publish, read the page signed out.
- [ ] **Step 3: Run them to verify they fail**
- [ ] **Step 4: Implement** — as above.
- [ ] **Step 5: Run, check and commit** — `feat(worker): import a locally built wiki as a generation for local testing`

---

## After the plan: the owner's local run (coordinator)

1. `pnpm hosted:profile seanpatrickmay` (uses `GITHUB_TOKEN` if set, else unauthenticated; about 50 requests, within the anonymous hourly limit).
2. `REPOWIKI_PROFILE=$HOME/.repowiki/hosted-local/seanpatrickmay.json REPOWIKI_LOCAL_PLAN=pro pnpm hosted:local`.
3. Sign in, build the six repositories that have local wikis (AlphaSettler, LecteurAide, Life-Dashboard, PokerML, RepoWiki, RotoText), write a contribution statement, review, preview, publish, and open `/seanpatrickmay`.
