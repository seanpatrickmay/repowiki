# RepoWiki v2 — People (sub-project #6) design spec

- **Date:** 2026-10-04
- **Status:** Draft. The design decisions were made on the owner's standing instruction to work autonomously; §18 lists the ones he is most likely to want to revisit.
- **Author:** Sean May
- **Features:** F14 people pages, F15 contribution graphs, F16 identity merge; also settles the blame half of F17 (ADR-0003)
- **Builds on:** v1 spec `2026-09-30-repowiki-v1-design.md` and `main` at 5824a0c. A bare § refers to this spec; "v1 §n" and "rule n" refer to the v1 spec.

## 1. Brief and goals

v1 documents a repository's features. People documents the people who built them:

- **F14 (person pages).** One page per contributor. It is a dated chronicle of what they did, in order, written in a sober register. Every sentence after the lead cites the person's own commits.
- **F15 (contribution graphs).** Activity over time for the whole repository and for each person, with zoom. The graphs are static SVG rendered at site build time.
- **F16 (identity merge).** The several names and emails one person commits under (for example `seanpatrickmay` and `Sean May`) become one person. The inputs are the repository's own `.mailmap`, read from git objects, a RepoWiki-side people file kept outside the repository, and deterministic automatic rules.

Goals, in priority order:

1. **Factual.** Every number is computed from git. Every narrative sentence cites commits that verify mechanically: they are the person's own commits, and their dates match the dates the sentence states. The model writes prose around the facts and never makes up a fact.
2. **Private by construction.** No email address, and no hash of one, reaches the export, the site, `llms.txt`, a prompt or ordinary terminal output. People can be excluded from everything RepoWiki generates about them; repository text that names them, such as a commit subject, is not rewritten (R12, C8).
3. **Cheap and incremental.** The computed facts cost $0. The narratives cost about $0.12 for a first run on next-chief-of-staff. An update rewrites only the people who have new commits.
4. **Deterministic.** The same repository, sha and people file always produce a byte-identical computed snapshot. The git that People runs is hermetic in the way M6 and M7 require.

## 2. What the owner gets

- `pnpm people:suggest <repo>` prints the identities RepoWiki found, how it grouped them, and suggested merges as a ready-to-paste people-file snippet. It never changes anything.
- `pnpm wiki:people <repo>` first prints an estimate. It then computes every person's facts (no LLM call) and writes narratives for the people who qualify, in one batched Haiku round plus one retry round, under `--max-usd`. Once it has run, People is **on** for that wiki: `wiki:update` and `wiki:replay` keep it fresh.
- The site gains:
  - `/people/`: every contributor, a repository-wide activity chart, and a by-feature contributors table.
  - `/people/<id>/`: the person page, with its infobox, all-time chart, per-year calendar heatmaps, chronicle, areas of work, pull requests and references.
  - `/special/activity/`, `/special/activity/<yyyy>/` and `/special/activity/<yyyy-mm>/`: repository activity at zoom levels a reader clicks through.
  - A **Main contributors** row on every feature page's infobox, and a **People** link in the site navigation.
- The JSON export carries `people`, so a later agent tool (#5) or Ask index (#4) can answer "who worked on X" questions without reading git; neither is in v2's tasks (C9). `llms.txt` lists the person pages.
- Open pull requests and issues from work in flight (M10) link their authors to person pages, and an excluded person's login disappears from them (C8).

On next-chief-of-staff (600 commits, of which 160 are merges; 15 distinct name/email pairs), the automatic rules group the authors into 8 humans and 1 bot. One people-file entry joins a handle (`wyattb`-style: first name plus last initial) to its full-name identity, which gives 7 human pages. All 7 have at least 3 commits, so all 7 get narratives.

## 3. Decisions

Every ruling has the form "Ruling: X — why — cost if wrong".

| # | Topic | Ruling |
|---|---|---|
| R1 | Blame (ADR-0003) | Ruling: People **uses** `git blame -C -C -M`, computed once at the wiki's head over every text file, to measure who wrote the code that exists now (current lines per person and per feature). It is never used per claim or per historical revision. — Commit counts measure activity; blame measures what survived, and blame is the only way to answer "who wrote this feature's current code". It is cheap: 27 s for all 429 files (69,143 lines) of next-chief-of-staff on the owner's machine, and incremental after that (R3). — Cost if wrong: about 30 s added to the first people run; dropping blame later removes one infobox row and the contributors table. ADR-0006 supersedes ADR-0003's deferral (C1). |
| R2 | Blame hermeticity | Ruling: blame runs through `scrubbedGitEnv()` as `git -c core.fsmonitor=false -c blame.ignoreRevsFile= -c blame.markIgnoredLines=false -c blame.markUnblamableLines=false -c diff.algorithm=myers blame --incremental -C -C -M --diff-algorithm=myers [--ignore-rev <sha>]… --end-of-options <sha> -- <path>`, with `--literal-pathspecs`. Only the commit sha and line count of each record are read. Author names in blame output are ignored, because blame applies the work tree's `.mailmap`; authors come from People's own log (R5). — This is the same rule as M6's diff ruling (pinned algorithm, env scrubbed) and M7's grep ruling (config injection stripped, no lazy fetch). — Cost if wrong: a hostile or unusual git config could change attribution; the hermetic test pins this. |
| R3 | Blame cache | Ruling: blame results are cached in the store by `(path, blob oid)` as run-length `[commitSha, lineCount]` lists. On an update, only paths whose blob changed, or that are new, are blamed again. Rows for `(path, oid)` pairs that are no longer in the head tree are pruned. — An unchanged path has an unchanged blame, because every line still comes from a commit at or before the old head. — Cost if wrong: a stale ownership share until the next full recompute (`wiki:people --rebuild-blame`). |
| R4 | Blame ignore-revs | Ruling: honour the repository's committed `.git-blame-ignore-revs`, read as a blob at the sha (never from the work tree). Each line must be 40 hex digits (others are skipped), at most 1,000 entries, passed as `--ignore-rev`. Sweep commits are not otherwise ignored. — The file is the repository's own statement that formatting sweeps are not authorship, and reading it from the blob keeps the run hermetic. — Cost if wrong: a repository's ignore list could hide a real author's lines; the owner can remove the file's effect with `ignoreRevs: false` in the people file. |
| R5 | Authorship source | Ruling: a commit belongs to its **author** (`%an`/`%ae`, raw, never `%aN`), dated by its **author date** in the author's own UTC offset (calendar date as written, as in rule 5 for readers). Committers are ignored. `Co-authored-by` trailers are ignored in v2. — The author did the work; a rebase or a GitHub web merge changes the committer; trailers are free text, and in next-chief-of-staff most of them name AI models. — Cost if wrong: pair-programmed work is credited only to the author. That is listed for the owner (§18). |
| R6 | Merges and PRs | Ruling: merge commits do not count as commits or lines. A pull request's **author** is the person with the most non-merge commits among the commits `readHistory` assigns to that PR; a tie goes to the author of the earliest commit, and a squash commit's author is its PR author. Its **merger** is the merge commit's author; a squash has no merger. Its **title** is the first line of the merge commit's body (where GitHub puts it), or a squash subject minus its trailing "(#N)". — This needs no network and no GitHub API, and it reuses v1's PR assignment. In next-chief-of-staff, merge authors are mostly the people who clicked Merge, not the PR authors. — Cost if wrong: a PR shared evenly between two people is credited to one of them. |
| R7 | Identity sources and precedence | Ruling: identities resolve in this order: the people file (explicit groups, `exclude`, `bots`) before the committed `.mailmap` blob at the sha, before automatic rules. Automatic rules join identities that share a case-folded email; share a GitHub login taken from a `users.noreply.github.com` address; where one identity's name equals another's login (case-insensitive); or that share a normalised full name of two or more words. An identity in an explicit group never joins anything automatically, so a group also splits a wrong automatic merge. — Explicit statements beat inference. The four automatic rules group next-chief-of-staff's 15 pairs into 9 people with no false merge, and they merge `seanpatrickmay` = `Sean May` with no configuration (name equals the noreply login). — Cost if wrong: two different people with the same two-word name merge until a group splits them. |
| R8 | Fuzzy matches are suggestions only | Ruling: handle-to-name matches (`wyattb` ≈ "Wyatt B…", first initial plus last name, first.last, and similar) are printed by `people:suggest` and never applied. — A wrong merge publishes one person's work under another's name; one pasted line fixes a missed merge. — Cost if wrong: the owner adds one entry per handle. |
| R9 | People file | Ruling: `<out>/people.json` (default `~/.repowiki/<repo>/people.json`, override `--people-file`), validated by a core zod schema. It is never read from or allowed inside the documented repository (a path inside it is refused, exit 2). Match keys are `name:`, `email:` and `login:`. — Exclusion lists name people who asked not to appear, so committing that list would leak it. The file follows the "data lives outside the repo" rule. — Cost if wrong: a team cannot share the file through the repository; it can share `.mailmap` instead. |
| R10 | Email privacy | Ruling: emails never appear in the export, the site, `llms.txt`, prompts or command output. `people:suggest` shows emails masked (first three characters of the local part, then `…@domain`). The store keeps only salted SHA-256 identity keys (the salt is random per store, in `meta`), never raw emails. Logins People derives from git identities (noreply addresses, people-file `login:` keys) appear only in `people:suggest`; the GitHub logins of open PR and issue authors are work in flight's (M10) data, shown as #9 R13 says, and an excluded person's is removed (C8). — The brief's rule, plus defence in depth if a store file leaks. — Cost if wrong: none for correctness; matching works through the keys. |
| R11 | Bots | Ruling: an identity is a bot if its name or login ends in `[bot]`, if it is on a fixed list (dependabot, renovate, github-actions, pre-commit-ci, snyk-bot, greenkeeper, mergify, codecov, allcontributors, imgbot), or if the people file lists it under `bots`. A bot gets no page and no narrative. It is listed on `/people/` under "Automated contributors" with its counts, and shown as its own series in the repository chart. — Bot work is real activity but not a person's story. — Cost if wrong: a human with a bot-like name loses their page until the people file lists them under `humans`. |
| R12 | Exclusion | Ruling: an excluded person (people file `exclude`) has no page, and People puts no name, id or login of theirs anywhere in the export, site or `llms.txt`; work in flight's authors resolving to them are exported as `null` (C8). Repository text that names them (commit subjects in citations, PR titles) is not rewritten, and `wiki:people` says so when it excludes someone. Their commits and current lines still count in repository totals, as an anonymous "other contributors" series. If they had a page, it disappears, with no redirect; privacy beats URL permanence. — The repository's activity is a fact about the repository; the person's identity is theirs. — Cost if wrong: with exactly one excluded person, "other contributors" is identifiable by elimination. The owner is told this when he excludes one person (§12). |
| R13 | Person ids | Ruling: a person id is a permanent kebab-case slug (at most 64 characters). It is made from the display name (NFKD, diacritics stripped, ASCII only). A name that slugs to nothing becomes `person-<n>`, and a collision gets `-2`, `-3` in order of first commit. Once published, an id survives renames; a merge turns the absorbed id into a redirect to the survivor. When a group splits, the larger side by commits keeps the id. The people file may set `id` before or after publication; a change leaves a redirect behind. — This is the same permanence promise as feature ids (rule 1), using the same machinery. — Cost if wrong: an awkward permanent id such as `seanpatrickmay`, fixed with a people-file `id` that leaves a redirect. |
| R14 | Display name | Ruling: the display name is, in order: the people file's `name`; the `.mailmap` proper name; the most frequent name with two or more words; the most frequent name. Ties go to the earliest commit. It is cleaned like an Architecture title (v1 §5 rule 12): 1–120 code points, no control or invisible characters. A name that cleans to nothing becomes `Contributor <n>`. — A real full name beats a handle. — Cost if wrong: a handle shown as a title until the people file names the person. |
| R15 | Narrative or no narrative | Ruling: hybrid. The facts (infobox, graphs, areas table, PR list) are always computed with no LLM call. The narrative (lead, chronicle, areas of work) is one batched Haiku call per eligible person, verified like a feature page. A person without a narrative gets a computed one-sentence lead ("X made N commits between D1 and D2."). Eligible means human, not excluded, at least 3 non-merge commits (`minCommits`), at most `maxNarratives` people (default 25, ranked by commits). `--no-narrative` gives $0 pages. — Facts must never depend on a model; prose is what makes F14 readable. — Cost if wrong: about $0.12 per first run on next-chief-of-staff. |
| R16 | Voice: F14 reshaped | Ruling: F14's "war-chronicle voice" becomes a **chronicle (annals) voice**: dated, in chronological order, past tense, sober. There are no martial metaphors, no evaluation of the person, no comparison with others, no motives unless a cited commit message states them, and no other person named. ADR-0007 records the reshape (C1). — War metaphors invite drama and judgement about real colleagues, which conflicts with NPOV (v1 §7.1) and with verifiability. The dated, episodic structure the owner asked for survives intact. — Cost if wrong: a flatter read. The voice lives in one style-guide file plus a banned-word list, so a bolder voice is a prompt change and a cassette re-record. |
| R17 | Citations on person pages | Ruling: person claims cite **commits only**, never code ranges. Every cited commit must be the person's own non-merge commit, or a PR merge commit for a PR they authored or merged. — Commits are immutable, so person claims never go stale (no remapping, no content hashes), and authorship is checkable. — Cost if wrong: no "wrote the scanner at `path:L1-L80`" sentences; the areas table links the feature instead. |
| R18 | Mechanical fact checks | Ruling: verify refuses a person claim that: states a date outside its cited commits' author-date range (for a lead, which cites nothing, the person's first-to-last commit range), at the granularity stated (day, month or year); is a chronicle claim with no date; states statistics (a number followed by commits, lines, files, pull requests, PRs or %); names another known person (any display name or other name of at least 4 characters, whole word); uses an evaluative or martial word from `PEOPLE_BANNED_WORDS`; or is an areas claim whose commits do not touch the one feature it links. — Each of these is a way a narrative about a real person goes wrong, and each can be checked without a model. — Cost if wrong: a few more claims dropped and retried (cents). |
| R19 | Commit → feature mapping | Ruling: a commit touches the features whose members are the files it changed. Paths are followed through renames (`git log -M`, walked newest first) to their path at the head, then looked up in the head manifest. A path missing from the head manifest takes its feature from the newest stored manifest that contains it. A path that never reached a stored manifest maps to none. — 858 of 2,690 file changes in next-chief-of-staff touch files deleted before the head; older manifests recover some of them in replayed wikis, and guessing by directory would invent links (the M2 "drop, don't guess" ruling). — Cost if wrong: a person whose work was mostly on deleted code shows fewer areas; the chronicle still covers those commits. |
| R20 | Lines metric | Ruling: line counts come from `--numstat` with `-M` (a move is not churn). Binary changes, lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`) and sweep commits (over `maxFilesPerCommit`, default 50, as for co-change) are left out of line counts. Sweep commits still count as commits. Blame skips lockfiles, binaries and files over `DEFAULT_MAX_FILE_BYTES`. — Generated files dominate raw line counts. — Cost if wrong: an unusual lockfile name inflates someone's lines; the list is one constant. |
| R21 | Graphs | Ruling: static inline SVG rendered at site build by a pure TypeScript function, with no new dependency and no client JavaScript. Zoom works through links. Bars are SVG `<a>` elements leading to a finer level: all time, then a year (weekly), then a month (daily). Each person page shows an all-time chart plus a weekday-by-week calendar heatmap for each active year. Tooltips are SVG `<title>`. Each chart has `role="img"`, an `aria-label`, and an accessible data table. — This works under the M5 CSP unchanged, is snapshot-testable, and loads nothing. — Cost if wrong: no drag-to-zoom or animated transitions. A later client script could add those without changing the data. |
| R22 | Bucketing | Ruling: the all-time chart uses the smallest bucket (day, ISO week, month, quarter) that gives at most 120 bars. Year pages use ISO weeks; month pages use days. Pages are generated only for years and months with activity. Days are the author's calendar date (R5). — This bounds SVG size and page count on long histories. — Cost if wrong: a 20-year repository's all-time chart is quarterly. |
| R23 | Feature → people links | Ruling: feature pages get a computed **Main contributors** infobox row: the top 5 people by current lines in the feature's files, as shares, plus "and N more" linking to `/people/#feature-<id>`. Feature claims never name people, and `Revision` is unchanged. — Feature pages stay about code (NPOV); the back-link is a computed fact and needs no new revision. — Cost if wrong: none; the row is pure rendering. |
| R24 | When People runs | Ruling: People is opt-in per wiki. `wiki:people` turns it on by storing the first snapshot, and `wiki:people --disable` turns it off. `wiki:build` never runs it (v1 build cost unchanged). Once People is on, `wiki:update` refreshes the snapshot at its head (no call) and then rewrites due narratives in one batched round. `wiki:replay` does nothing for People per step; it refreshes once at its final head. — Facts are cheap and should never lag. Narratives at every replay step would cost about $0.01 × 160 steps for prose that the next step replaces. — Cost if wrong: replayed wikis have no historical person-page revisions (pages carry no "View history" in v2 anyway, R27). |
| R25 | Due narratives | Ruling: a person's narrative is due when they have non-merge commits newer than its `basis`, when their identity group changed (a merge or split makes it due **whole**), or when the narrative is missing. Otherwise it is carried forward word for word. An append keeps every stored chronicle claim; the model adds new chronicle claims and rewrites the lead and the areas section. Links to features that no longer route render as plain text, as on stored pages (M6). — This mirrors M6's update rounds and the append-only History rule (rule 4). — Cost if wrong: a lead that summarises older work until the next append. |
| R26 | Cost caps | Ruling: `wiki:people` prints its estimate before any call; `--max-usd` (default $1, at most $100, parsed as `eval:run` parses its `--max-usd`) is a ceiling under C12's rule: due narratives are taken in rank order (commits, descending), each counted at its ceiling including a retry, while the next fits; the rest are reported "over budget" and stay due. `wiki:update` and `wiki:replay` cap their People round the same way with `--people-max-usd` (default $0.50); the summary says what was skipped (exit 0). Due narrative calls count in the up-front key check, as the About article's do (M6 ruling). — This follows the brief's "estimate first, cap" rule without changing v1 update semantics. — Cost if wrong: a skipped round is retried on the next run. |
| R27 | Revisions and history | Ruling: person narratives are stored as a revision chain (`parentId`, like Architecture), but the export carries only the current revision and the site shows no history view for people in v2. — Narratives are append-only chronicles, so older revisions add little, and this keeps the export small. — Cost if wrong: one later additive export field and two site routes. |
| R28 | Export shape | Ruling: `WikiExport.people` is added within schema 3 with a default of `null`, as `architecture` and `runs` were. `SCHEMA_VERSION` stays 3, and every earlier export parses. — This is the established additive pattern (v1 §5 rule 12). — Cost if wrong: none. |
| R29 | Store | Ruling: one appended migration adds four new tables: `people_registry`, `people_snapshot` (latest row only), `person_revisions` and `blame_cache`. It rewrites no stored body. It is migration 10: `main` ships 8 and work in flight (M10) takes 9 (C2). — New tables reject nothing already stored. — Cost if wrong: none. |
| R30 | LLM role | Ruling: a new `LlmRole` value `people` (default `claude-haiku-4-5` in `DEFAULT_MODELS`, added in the same task, C6) labels and prices people calls (its run kind is R33). Adding an enum value rejects no stored ledger row. — Per-role config and ledger purpose (v1 §4). — Cost if wrong: none. |
| R31 | Where code lives | Ruling: git readers (`readAuthorship`, `readBlobAt` for `.mailmap` and `.git-blame-ignore-revs`, `blameFile`) go in `engine/index/` beside `readHistory`, so every git spawn shares `scrubbedGitEnv`. The new `engine/people/` module holds identities, registry, snapshot, pack, prompt, rounds and update. Schemas and the pure `contributorsOf()` go in `@repowiki/core`, so the site, #5 and #4 share them without importing `engine` or `eval`. `write/` exports its generic round helpers (`uniqueDraft`, `verifyClaims`, `fixRequest`, `retryRequest`) and `featureDirectory` through `write/index.ts`. — This respects the engine boundary rule and the brief's "extract shared pieces into a package" rule. — Cost if wrong: one re-export. |
| R32 | Large teams | Ruling: narratives are capped at `maxNarratives` (default 25). Everyone else gets a computed page. The pack is budgeted at 20,000 estimated tokens per person and trims deterministically (§8.2). — This bounds cost on open-source-sized repositories (25 × about $0.02 = $0.50 worst case). — Cost if wrong: the 26th most active contributor has no narrative until the owner raises the cap. |
| R33 | Run kind | Ruling: `RunKind` gains `people`. Every People call's ledger row carries `runKind: "people"` and `sha` set to the head it documents, including the People round inside `wiki:update` and `wiki:replay`. — People spend then shows in `WikiExport.runs` as its own run and never counts toward build or update totals, so the replay invariant "every update costs fewer tokens than the last full build" (v1 §8) still measures v1's pipeline. This mirrors #9's `inflight` run kind. — Cost if wrong: none; widening an enum rejects no stored row. |

## 4. Architecture

```
packages/core/src/
  person.ts          PersonId, PersonName, CalendarDay, ActivityDay, PullRequestRef, PersonFacts,
                     PeopleSnapshot, PersonSectionKey, PersonRevision, personClaimViolations,
                     PeopleExport, contributorsOf()                         (pure, no I/O)
  people-config.ts   PeopleConfig (the people file), MatchKey
  export.ts          WikiExport.people: PeopleExport | null  (default null)
  llm.ts             LlmRole += "people", RunKind += "people" (R33)
packages/engine/src/
  index/authorship.ts   readAuthorship(repo, sha): AuthoredCommit[]   (log -z, -M, --numstat)
  index/blob.ts         readBlobAt(repo, sha, path): string | null      (.mailmap, .git-blame-ignore-revs)
  index/blame.ts        blameFile(repo, sha, path, ignoreRevs): BlameRun[]   (R2)
  people/
    mailmap.ts       parseMailmap(text) -> rules; applyMailmap(identity, rules)
    identities.ts    resolveIdentities(commits, mailmap, config, salt) -> IdentityGroups   (R7, R11, R14)
    registry.ts      assignIds(groups, stored registry, config) -> { people, redirects, registry }  (R13)
    suggest.ts       suggestMerges(groups) -> Suggestion[]                                  (R8)
    ownership.ts     blameTree(repo, sha, store, options) -> lines per (commit, path)       (R1, R3)
    snapshot.ts      computeSnapshot(...) -> PeopleSnapshot                                 (§7)
    pack.ts          personPack(person, snapshot, commits, manifest, budget) -> text        (§8.2)
    prompt.ts        PEOPLE_INSTRUCTIONS, people-style.md, peopleSystemPrompt(repo, manifest)
    verify.ts        verifyPersonClaim(key, draft, ctx)                                     (R17, R18)
    write.ts         writePeople(...) rounds: batch + retry                                 (§8.4)
    update.ts        duePeople(...), appendRequest(...)                                     (R25)
    resolve.ts       resolvePerson(store, { login?, name?, email? })   (for #9, §16)
    index.ts
  store/             migration (R29); registry, snapshot, person revision and blame-cache methods
  store/export.ts    buildExport adds `people` (current revisions, excluded filtered) and, when
                     People is on, resolves M10's in-flight authors through resolvePerson (C8)
packages/site/src/
  activity-svg.ts    barChart(series, range, bucket), heatmap(days, year)   (pure, escaped)
  people.ts          view models: peopleIndexView, personView, activityView, contributorsRow
  pages/people/index.astro, pages/people/[id].astro,
  pages/special/activity/index.astro, [period].astro
scripts/
  people-suggest.ts, wiki-people.ts, people-cli.ts (args, estimate, summary)
  wiki-update.ts, wiki-replay.ts, update-run.ts   (People step after M10's in-flight step,
                                                   before the one export write; R24, C14)
  wiki-check.ts      person revisions re-verified
```

**Data flow of `wiki:people <repo>`:**

1. `readAuthorship` at the store's head reads every commit with author identity, author date, parents, subject, first body line for merges, and numstat with renames.
2. Read the mailmap and ignore-revs blobs at the head, then read the people file.
3. `resolveIdentities` → `assignIds` against the stored registry.
4. `blameTree`: cached by `(path, oid)`, 4 concurrent `git blame` processes, a 120 s timeout per file (a timed-out file counts as unattributed and is reported).
5. `computeSnapshot`, then store the snapshot and the registry in one transaction.
6. Plan narratives (eligible and due), print the estimate, check `--max-usd` and the key.
7. `writePeople` runs round 1 as one batch and the retry as one batch, verifying claims as they arrive. Person revisions are stored.
8. Write the export and `llms.txt` (as wiki:build does), plus a summary file `people-<sha7>.md`.

The run holds the out dir's build lock (M4/M6), so it never runs alongside a build or update. Batches are journaled (M4), so a killed run collects what it has already paid for.

## 5. Data model

```ts
PersonId      = string  // ^[a-z0-9]+(?:-[a-z0-9]+)*$, at most 64 chars; a separate namespace from FeatureId
PersonName    = string  // 1–120 code points, trimmed, no control or invisible characters (ArchitectureTitle's rule)
CalendarDay   = string  // YYYY-MM-DD, a real calendar date
ActivityDay   = { day: CalendarDay, commits: int ≥ 0, added: int ≥ 0, deleted: int ≥ 0 }
PullRequestRef = { number: int > 0, title: string | null /* ≤ 200 code points, cleaned */,
                   mergedAt: IsoDateTime }

PersonFacts {
  id: PersonId, name: PersonName, otherNames: PersonName[] /* ≤ 10, sorted, never emails or logins */,
  kind: "human" | "bot",
  firstCommit: IsoDateTime, lastCommit: IsoDateTime,      // author dates
  commits: int, added: int, deleted: int,                 // non-merge; R20 exclusions
  currentLines: int,                                      // blame at the snapshot's sha
  prsAuthored: PullRequestRef[], prsMerged: int[],        // R6, both ascending by number
  features: { featureId: FeatureId, commits: int, currentLines: int }[],  // by currentLines desc, commits desc, id
  activity: ActivityDay[]                                 // non-zero days only, ascending
}

PeopleSnapshot {
  sha: GitSha, commitDate: IsoDateTime,
  people: PersonFacts[],                                  // sorted by id; no excluded person
  redirects: { from: PersonId, to: PersonId }[],          // merged-away ids; no chains, no cycles
  others: ActivityDay[],                                  // excluded people plus unattributed, anonymous
  featureLines: Record<FeatureId, int>,                   // current lines per feature (share denominator)
  totalLines: int, unattributedLines: int                 // blame timeouts, excluded authors
}

PersonSectionKey = "lead" | "chronicle" | "areas"
PersonRevision {
  id: string /* person-<personId>-<sha12>-<n> */, personId: PersonId,
  sha: GitSha, commitDate: IsoDateTime, generatedAt: IsoDateTime, parentId: string | null,
  reason: "build" | "update", model: string, tokens: TokenUsage,
  basis: GitSha,                                          // the newest of the person's commits it covers
  sections: { key: PersonSectionKey, claims: Claim[] }[]  // lead, chronicle, areas in order
}

PeopleExport { snapshot: PeopleSnapshot, pages: PersonRevision[] /* current, one per person */ }
WikiExport  += { people: PeopleExport | null }            // default null, schema 3 (R28)
```

### Rules

1. **Person claims** (`personClaimViolations`, in core):
   - Lead claims cite nothing and support at least one body claim.
   - Chronicle claims are `history` claims with at least one commit citation.
   - Areas claims are `fact` claims with at least one commit citation and exactly one `[[featureId]]` link token.
   - No claim carries a code citation, and none is a `limitation`. `hook` is always false: people never appear in "Did you know…".
2. **Export integrity** (`WikiExport` superRefine):
   - Every page's `personId` is a human in the snapshot, and each appears once.
   - Every `features[].featureId` and every key of `featureLines` is in the manifest.
   - Redirect sources are not snapshot people, and their targets are.
   - The revision's chain is not checked in the export, because only current revisions are exported (R27).
3. **No email anywhere.** No core schema in the export has a field that can hold an email. A core test asserts that a fixture export built from addresses like `x@example.com` serializes with none of them.
4. **Dates.** A person's dates are author dates, shown as the calendar date written in their own offset (v1 §4 Reader, rule 5).
5. **The registry is private.** `people_registry` rows (`{ id, name, kind, status: active | redirect | excluded, keys: string[] /* salted sha256 */ }`) never leave the store.

### Store (R29)

```sql
CREATE TABLE people_registry (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE people_snapshot (sha TEXT PRIMARY KEY, body TEXT NOT NULL);        -- one row, replaced
CREATE TABLE person_revisions (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  person_id TEXT NOT NULL, parent_id TEXT REFERENCES person_revisions(id), body TEXT NOT NULL);
CREATE INDEX person_revisions_person ON person_revisions(person_id);
CREATE TABLE blame_cache (path TEXT NOT NULL, oid TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (path, oid));
```

The identity salt is stored in `meta` under the key `people.salt` (32 random bytes, hex). Every body is parsed with its core schema on write and on read. `putPersonRevision` checks the parent the way `putArchitecture` does.

### The people file (`PeopleConfig`, R9)

```json
{
  "people": [
    { "name": "Wyatt Example", "id": "wyatt-example", "match": ["name:wyattx", "login:wexample"] }
  ],
  "exclude": ["name:Someone Private"],
  "bots": ["name:release-runner"],
  "humans": [],
  "minCommits": 3,
  "maxNarratives": 25,
  "ignoreRevs": true,
  "othersMinPeople": 1
}
```

- A match key is `name:<text>` (case-insensitive, whitespace-collapsed), `email:<address>` (case-insensitive) or `login:<github-login>`.
- A key that matches no identity is a warning, not an error, so a typo is visible without breaking anything.
- A key in two groups, or in both a group and `exclude`, is an error (exit 2) that names the key, never the email behind it.

## 6. Identity resolution (F16)

1. **Raw identities.** These are the distinct `(name, email)` author pairs over every commit reachable from the head. Names are untrusted: they are cleaned (control, bidi and invisible characters become U+FFFD and are then dropped from display) and capped at 120 code points.
2. **Mailmap.** `.mailmap` is read as a blob at the head (`readBlobAt`), never from the work tree, and never through `git check-mailmap` (which reads the work tree). All four mailmap line forms are parsed, with `#` comments; malformed lines are skipped and counted. The mailmap maps an identity to a proper name and/or email before grouping.
3. **People file.**
   - Explicit groups are applied first, and their identities are fenced off from automatic joins.
   - `exclude` marks a group or an identity as excluded. Exclusion beats grouping: if any identity of a group is excluded, the whole group is.
   - `bots` and `humans` override bot detection.
4. **Automatic joins** (union-find, R7) over the identities left over. Each join records its reason (`same email`, `same login`, `name is login`, `same full name`) for `people:suggest`.
5. **Display name and id** (R14, R13). Then `assignIds` matches each group to stored registry rows by identity-key overlap (most shared keys wins; ties go to the oldest row):
   - A group that overlaps two stored people keeps the larger one's id and turns the other into a redirect.
   - A stored person whose keys split across groups stays with the group that has more of the person's commits; the other group gets a new id.
6. **`people:suggest`** prints one table row per group: id, display name, other names, masked emails, logins, commits, and join reasons. It then prints suggested merges (R8), each with its rule (`handle = first name + last initial`, `first.last`, `flast`, an email local part equal to a handle) and a JSON snippet to paste. Its output goes through the same printable/redaction helpers as other CLIs.

`resolvePerson(store, { login?, name?, email? })` returns `{ kind: "person", id } | { kind: "bot" } | { kind: "excluded" } | null`, using the stored registry keys. People's `buildExport` step uses it to link work in flight's PR and issue authors (P23, §16, C8).

## 7. Computed facts (F15 data, ownership)

- **Activity.** For each non-merge commit there is one `ActivityDay` increment for its author's person on the author's calendar day, with lines per R20. Days with no activity are omitted. An excluded author's increments go to `others`.
- **Areas.** For each person and feature: `commits` is the person's non-merge commits that touch the feature (R19); `currentLines` comes from blame. A feature appears in a person's list if either is non-zero. Retired features keep their commits but have no current lines.
- **Ownership (R1–R4).**
  - `blameTree` lists blobs at the head (`listBlobs`), skips binaries, lockfiles and files over `DEFAULT_MAX_FILE_BYTES`, and blames each path that is not cached.
  - Each blamed line's commit maps to its author's person; an excluded author's lines go to `unattributedLines`.
  - Per-feature lines come from the head manifest's file membership.
  - Every share is shown as `currentLines / featureLines[id]`, rounded to whole percents only at render.
- **Pull requests** follow R6.
- **Determinism.**
  - Every list has a stated sort order, and every map is serialized with sorted keys.
  - Blame runs concurrently, but results are keyed by path and folded in path order.
  - The snapshot JSON for the same sha, people file and stored registry is byte-identical across runs; a test runs it twice and compares.

Sizing on next-chief-of-staff at 7247d28:

| | |
|---|---|
| Commits / merges | 600 / 160 |
| Raw author pairs | 15; 8 human groups and 1 bot automatically; 7 humans with one people-file entry |
| Blame | 429 blobs, 69,143 lines, about 27 s first run (`-C -C -M`), seconds per update |
| File changes on paths deleted before the head | 858 of 2,690 (32%), so R19 matters |
| Export growth | about 600 activity days, facts for 9 people, 7 narrative revisions; well under 200 KB |

## 8. Narrative (F14)

### 8.1 Voice (R16): `engine/people/people-style.md`

- **The lead** is 2–3 sentences. It opens with the person's name in bold and says when they contributed (a dated range, in the past tense) and to which features (linked).
- **The chronicle** is one claim per episode, oldest first. Each claim opens with its date ("On 14 March 2026, …", "In March 2026, …", "Between January and February 2026, …") and says what changed, in terms of the features and the commit subjects. It is past tense.
- **Areas of work** has one claim per main feature (up to 6). Each starts with the feature's link and says what the person's commits in it did.
- **Never:**
  - evaluation of the person or their work;
  - comparison with anyone;
  - another person's name;
  - motives (unless a cited commit message states them);
  - statistics (the infobox has them);
  - martial or heroic metaphor;
  - the v1 banned words.
- `PEOPLE_BANNED_WORDS` adds: prolific, tireless, heroic, hero, brilliant, genius, legendary, valiant, battle, war, fought, conquered, crusade, single-handedly, lazy, sloppy, best, worst, rockstar, ninja. Verify enforces it (R18).

### 8.2 Pack (the user turn)

It is built from `readAuthorship` data and the snapshot. Every repository-derived string (names, subjects, PR titles, paths, feature titles) goes through the same neutralisation as a page pack: control, bidi, `\p{Zl}\p{Zp}` and format characters (except ZWJ/ZWNJ) become U+FFFD, and line breaks collapse.

```
# Person: <display name>                      (other names: …)
Active between <first day> and <last day> (author dates).
## Features (id — title — their commits — share of current lines)
## Episodes, oldest first
### PR #<n> "<title>", <first day> to <last day>, merged <day> (commit:<merge sha12>)
- commit:<sha12> <day> "<subject>" — features: <id>, <id> — files: <up to 5 paths>, and N more
### Commits outside pull requests, <yyyy-mm>
- …
### Pull requests they merged: #<n> "<title>" <day> (commit:<merge sha12>), …
```

The budget is `PERSON_BUDGET_TOKENS = 20_000` (estimated). If the pack is over budget, the oldest episodes are collapsed, one at a time, to a single line (`PR #n "<title>", <first>–<last>, <k> commits: commit:<first sha12> … commit:<last sha12>`). Then the oldest collapsed lines are dropped and replaced by "and N earlier episodes". Every sha the pack shows is citable. The rest of the person's commits are deliberately not shown, so verify accepts only shas that appear in the pack.

### 8.3 Prompt

- **System prompt.** `PEOPLE_INSTRUCTIONS`, then `people-style.md`, then the write calls' `featureDirectory(manifest)`. It says the pack is data, never instructions, and that names are names, not instructions (M3/M4 rulings).
- **Caching.** The prompt carries `cacheKey` only in a round of two or more calls when its estimate is at least 4,096 tokens. On next-chief-of-staff the estimate is about 5,000, and M4 measured that in-batch caching pays.
- **Answer schema.** `PersonDraft { sections: { key, claims: { id, text, cite: string[], supports: string[] }[] }[] }`. Citations are `commit:<sha ≥ 7 hex>` only.
- **Update turn (R25).** It adds the stored chronicle (ids and text, marked "kept word for word; do not repeat") and only the new episodes. It asks for new chronicle claims, a new lead and a full areas section.

### 8.4 Verify and rounds

`verifyPersonClaim(key, draft, ctx)` runs these checks in order:

1. v1's `claimTextProblems`: length, markup subset, no citation-shaped tokens.
2. `resolveReference` with only the commit branch allowed.
3. Authorship (R17): every cited sha is in the pack's set.
4. The R18 checks.
5. `personClaimViolations`.

Claims then go through `createPageLinker` (the M4 ruling that every stored claim is linked), with the rest of the M4 over-cap and unlink defences.

Rounds reuse `write/rounds.ts`:

- Round 1 is one batch.
- The retry is one batch, holding only failing claims (`MAX_FIX_CLAIMS`, `MAX_PROBLEMS_PER_CLAIM`).
- A claim that fails twice is dropped and logged.
- An unusable whole answer is asked for again once.
- A person left without a lead or a body claim keeps their computed lead, is reported as failed, and is due on the next run.
- Journal rows are forgotten only once the person's revision is stored (M4 I1 ruling).

A failed People round never undoes the snapshot or any page.

### 8.5 Cost (Haiku 4.5 via `packages/llm/src/pricing.ts`: $1 in, $5 out, $1.25 cache write, $0.10 cache read per MTok, batch × 0.5)

| Run on next-chief-of-staff | Calls | Tokens (in / out) | Cost |
|---|---|---|---|
| `wiki:people`, first run, 7 narratives, round 1 | 7 | about 56k (7 × 5k system + 21k packs) / about 17.5k | $0.072 uncached; about $0.059 with in-batch caching |
| Retry round (assume 5 of 7, as in M4's 74%) | 5 | about 55k / about 7.5k | $0.046 |
| **First run, total** | ≈ 12 | | **≈ $0.12** (printed upper-side estimate ≈ $0.17, since `estimateTokens` runs about 46% high on prose) |
| `wiki:people --no-narrative`, or any run with nothing due | 0 | | $0 |
| `wiki:update` step whose new commits have one human author | 1 (+≤ 1 retry) | about 9k / 1k | ≈ $0.007–0.012 |
| `wiki:replay` end-of-run refresh (≤ 7 due) | ≤ 12 | as the first run | ≤ $0.12 once per replay, not per step |
| RepoWiki itself (1 person, about 660 commits, pack trimmed to 20k) | 1 (+1) | about 25k / 3k | ≈ $0.02 |
| Blame, facts, graphs, site | 0 | | $0 |

## 9. Freshness (`wiki:update`, `wiki:replay`)

- **`wiki:update shaA → shaB`** (R24) runs v1 §6.1 unchanged. If People is on, then after the pages and the About article are stored and work in flight's offline re-derive has run (M10, C14), it takes three steps:
  1. **Refresh.** `readAuthorship` at shaB (the log is about 0.2 s on next-chief-of-staff), identities, registry, incremental blame (only paths whose blob changed between shaA and shaB, plus new paths), then the snapshot. It makes no call.
  2. **Due narratives** (R25), with the estimate printed up front alongside the update's own estimate. The round is capped by `--people-max-usd`.
  3. **Export.** The export and `llms.txt` are written once, after both steps (C14). The summary file gets a People row: people refreshed, narratives written, carried or skipped (and why).
- **`wiki:replay`** runs its steps as in M6, then performs the update's People steps once at the final head. If a replay stops early (`--limit`), the refresh runs at the head it reached.
- **A people-file change** is picked up by the next refresh. Merges and splits make the affected narratives due whole. A newly excluded person's revisions stay in the store but leave the export at once. To erase them from the store as well, run `wiki:people --forget <match-key>` (for example `--forget "name:Someone Private"`; an excluded person's id is never shown, so the flag takes a people-file match key). It deletes the person's revisions and registry row.
- **`wiki:check`** re-verifies every current person revision against the stored snapshot's commit set and the current identity map: authorship, dates, link routing. It also checks that the export, `llms.txt` and the site's HTML (when present) contain no email from the author set. That check reads the emails from git at check time and never prints them.

## 10. CLI

```
pnpm people:suggest <repo-path> [--out dir] [--people-file file]
pnpm wiki:people   <repo-path> [--out dir] [--people-file file] [--config file.json]
                   [--no-narrative] [--only <person-id>]… [--rebuild-blame] [--no-batch]
                   [--max-usd N] [--dry-run] [--disable] [--forget <match-key>] [--verbose]
pnpm wiki:update / wiki:replay … [--people-max-usd N]      (new flag; everything else unchanged)
```

- All commands share `wiki-cli`'s argument rules: a repeated flag, an empty value or an unknown flag is a usage error (exit 2), with the bad option echoed safely. A missing key fails once, up front, when the estimate shows calls (keyless message as in M6).
- **`wiki:people` works only on a built wiki.** It requires a stored head and manifest (otherwise "run wiki:build first", exit 2) and documents the store's head, never a new sha.
- **`--dry-run`** prints the people table (ids, names, commits, narrative due or not) and the estimate, then stops.
- **`--only`** narrows narratives, never facts.
- **The summary** `people-<sha7>.md` lists each person's id, display name, commits, narrative status (written, carried, computed-only, failed) and claims dropped, then the LLM cost block in the format the build summary uses. Every name goes through `markdownCodeSpan`/`markdownOneLine`.

## 11. Site

- **Routes.**
  - `/people/`: repository activity chart (all time) → people table (name, active range, commits, current share, sparkline) → "Automated contributors" → "By feature" (an anchor per feature `#feature-<id>`, with each contributor's share).
  - `/people/<id>/`: the person page.
  - `/people/<old-id>/`: a redirect page, like a feature redirect.
  - `/special/activity/`, `/special/activity/<yyyy>/`, `/special/activity/<yyyy-mm>/`.
  - All are generated only when `wiki.people !== null`. An export with `people: null` renders exactly the v1 site: no new route, and every existing snapshot is unchanged.
- **The person page.**
  - Title and the tagline "From the <repo> wiki".
  - Infobox: other names, active range, commits, lines added and removed, current lines and share, PRs authored (count), PRs merged (count), main features.
  - Lead: the narrative's, or the computed one.
  - Activity: the all-time bar chart, then one heatmap per active year, each under an `#activity-<yyyy>` anchor. Clicking an all-time bar jumps to its year's anchor.
  - Chronicle.
  - Areas of work: the narrative claims, then the computed table.
  - Pull requests: number, title, merged date; links to `<repo-url>/pull/<n>` with `--repo-url`.
  - References: numbered commit citations, linking to `<repo-url>/commit/<sha>`.
  - "Narrative as of <date> (<sha7>)", plus "N newer commits are not yet in the narrative" when the narrative is due.
- **Charts** (`activity-svg.ts`, R21–R22).
  - **Repository charts** stack bars by person: the top 8 by commits in the range, then "others" (other people, excluded people and unattributed lines), then "bots", in a fixed palette order with legend entries linking to person pages.
  - **Person charts** are a single series.
  - **Every bar** is an `<a>` to the next zoom level, wrapping a `<rect>` with a `<title>` such as "Week of 9 Mar 2026: 12 commits, +840 −120 lines".
  - **Colours** are CSS custom properties in `wiki.css` with light and dark values.
  - **Escaping.** Every string in an SVG passes through `xmlText()` (escapes `& < > " '`, and drops `INVISIBLE_CHARACTERS` and control characters).
  - **Size.** The SVG has a fixed `viewBox` and scales by CSS.
  - **Accessibility.** A visually hidden `<table>` after each chart holds the same numbers.
- **Feature pages** (R23). `Article.astro`'s infobox gets the computed **Main contributors** row when the export has People; feature pages with no blamed lines get no row. `contributorsOf(people, featureId, 5)` from core supplies it. The row carries `data-pagefind-ignore`, so a name search finds person pages rather than every feature page (C9).
- **Navigation and search.** The Layout's nav gains **People** when the export has People, last, after M10's "In progress" (C10). Person pages carry `data-pagefind-body` (search finds them by name, other names and narrative). Redirect and activity pages do not. Person pages are not in `@repowiki/query`'s index, so the MCP server and the ask's served answers do not cite them (C9); the ask's static-mode client lists Pagefind results, so its link pattern (#4 R19) gains `/people/<id>/`.
- **Work in flight's pages** (M10): an author People resolves to a person links `/people/<id>/`; one resolved as excluded is exported as `null` and shown as "unknown author" (C8).
- **No new dependency, no client script, CSP unchanged.** The no-external-assets and crawl tests cover the new routes.

## 12. Security, privacy and untrusted text

| Text | Source | Neutralised as |
|---|---|---|
| Author names, mailmap names | git and blobs at the sha | cleaned and capped at the boundary (R14). In prompts: the pack's neutraliser and `quote()`. In HTML: Astro text escaping. In SVG: `xmlText()`. In `llms.txt`: `llmsTxtLine`. In terminal and summary output: `printable()` and the markdown helpers. |
| Emails, logins | git | never output (R10). Salted keys in the store. Masked or login-only in `people:suggest`. Redacted by `describeError` if they appear in an error path (an email-pattern redaction is added alongside the key redaction). |
| Commit subjects, PR titles | git | as v1 page packs and commit citations. Titles are capped at 200 code points. |
| `.mailmap`, `.git-blame-ignore-revs` | blobs at the sha | parsed as data. Ignore-revs keep only 40-hex lines (R4). Neither is ever handed to git as a file. |
| People file | owner, outside the repo | zod-validated. Errors name the key kind and position, never the value of an `email:` key. |
| Model output | Haiku | v1 verify, link and over-cap defences plus R18. Person claims cannot carry code citations or name other people. |
| Git invocation | | `scrubbedGitEnv()`; `--end-of-options`; `--literal-pathspecs`; `-c core.fsmonitor=false`; R2's pinned blame config. Reads only objects at the sha, never the work tree, and writes nothing in the repo. |

**Privacy defaults, stated plainly.**

- Every non-bot contributor with at least 3 commits gets a narrative unless excluded.
- When the owner excludes exactly one person, `wiki:people` prints that the anonymous "other contributors" series is then that one person's activity. It suggests `othersMinPeople: 2` (a people-file field, default 1), which folds "others" into the repository total, so the series is never shown alone.

## 13. Testing

- **Fixture repositories** (`index/test-repo.ts`, extended). Scripted histories with per-commit `GIT_AUTHOR_NAME`/`EMAIL`/`DATE`:
  - noreply addresses and bot authors;
  - a committed `.mailmap` that differs from the work-tree copy;
  - `.git-blame-ignore-revs`;
  - renames, a moved block for `-C`, and deletions;
  - "Merge pull request #N" merges with PR-title bodies, and a squash "(#N)";
  - lockfiles and a sweep commit.
- **Hostile input.**
  - Names with bidi, NEL, zero-width characters, `[[x]]`, `**`, `<script>`, `</svg>` and 500 characters.
  - A subject forging a record or a blame header.
  - Malformed mailmap lines.
  - A people file with an email key and an unknown key.
  - A path with `#`, `%`, a leading newline or unicode.
- **Hermetic blame.** The fixture repo's config sets `diff.algorithm=patience`, `blame.ignoreRevsFile=<file>`, `blame.markIgnoredLines=true` and `core.fsmonitor`. The environment sets `GIT_CONFIG_COUNT/KEY_0/VALUE_0`, `GIT_CONFIG_PARAMETERS`, `GIT_DIR` and `GIT_DIFF_OPTS`. The work-tree `.mailmap` is changed. The ownership result must be identical to a clean run.
- **Determinism.** The snapshot JSON is byte-equal across two runs and across shuffled log order. Ids are stable after adding a people-file group, and a redirect appears.
- **Identity unit tests.** Each R7 rule, fences, exclusion beating grouping, bots and `humans`, display-name precedence, id collisions, the non-Latin fallback, and the split and merge registry cases. One anonymised table reproduces next-chief-of-staff's 15 pairs.
- **Verify unit tests.** Each R18 check, positive and negative: dates at day, month and year granularity; ranges; statistics; other names; banned words; areas claims touching the feature; and commit authorship, including merges a person merged.
- **Privacy tests.**
  - With a fixture whose emails are known, the export JSON, `llms.txt`, every built site file, the summary `.md` and captured stdout/stderr contain none of the emails or their local parts. `people:suggest` shows only masked forms.
  - An excluded person's name and id appear nowhere in the export, site or `llms.txt`.
- **Cassettes.** `people.claude.test.ts` records one batched round plus one retry for 2 fixture people, and one append. These are 3 live recordings, about $0.01–0.02 in all. Tests never reach the network, and cassettes carry no headers (v1 §8).
- **Site.** Golden snapshots of `/people/`, a person page, a redirect, `/special/activity/` and a year page, plus an SVG snapshot and a hostile-name SVG test. The crawl test covers every bar link. Tests assert the CSP meta is unchanged and that the pages load nothing off-site. The existing site snapshots, built from `people: null` exports, must pass unchanged.
- **Store.** Migration 10 from a v9 store (C2), round-trip, parent check on person revisions, blame-cache pruning, and a real-Node smoke test (M3 ruling).

## 14. Milestone breakdown

This is the People milestone, **M11**, last in the fixed v2 order (#5 M8, #4 M9, #9 M10, #6 M11); it starts after M10 has merged. Tasks are written `P1…P27` below; branches are `m11/people-<short>`. Each task is one `[M11]` sub-issue under F14, F15 or F16, and one PR of about 300 changed lines or fewer (fixtures, cassettes and snapshots excluded). TDD, commits at every green step, merge commits.

| Task | Contents | Feature | ≈ Lines |
|---|---|---|---:|
| P1 | ADR-0006 (blame for People; supersedes ADR-0003's deferral, whose status it updates), ADR-0007 (F14 voice reshaped to chronicle; trailers ignored) (C1), `seed.json` tickets | F14, F17 | 180 |
| P2 | core `person.ts`: PersonId, PersonName, CalendarDay, ActivityDay, PullRequestRef, PersonFacts, PeopleSnapshot + tests | F15 | 250 |
| P3 | core: PersonSectionKey, PersonRevision, `personClaimViolations` + tests | F14 | 200 |
| P4 | core: PeopleExport, `WikiExport.people` (default null) + integrity rules, `LlmRole` and `RunKind` `people` with `DEFAULT_MODELS.people` (C6), `contributorsOf()`; no-email export test | F14 | 260 |
| P5 | core `people-config.ts`: PeopleConfig and match keys + tests | F16 | 150 |
| P6 | index `authorship.ts`: `readAuthorship` (NUL-parsed log, author fields, merge body line, numstat `-M`; PR numbers from `readHistory`'s existing assignment, shared rather than copied) + hostile tests | F15 | 280 |
| P7 | index `blob.ts` and people `mailmap.ts`: blob at sha, mailmap parse and apply + tests | F16 | 220 |
| P8 | index `blame.ts`: hermetic `blameFile`, stateful incremental parse, ignore-revs, timeout + hermetic test | F15 | 260 |
| P9 | store migration 10 (four tables, salt; C2) + methods for the registry, snapshot, person revisions and blame cache + round-trip tests | F14 | 280 |
| P10 | people `identities.ts`: resolution, fences, exclusion, bots, display name, salted keys | F16 | 290 |
| P11 | people `registry.ts`: id assignment, permanence, redirects, split and merge, config ids | F16 | 280 |
| P12 | people `ownership.ts`: blame over the tree with cache, concurrency, lockfile and size skips, pruning | F15 | 230 |
| P13 | people `snapshot.ts`: activity, areas (R19 rename map plus older manifests), PRs (R6), shares; determinism tests | F15 | 290 |
| P14 | `people:suggest` script + `suggest.ts` (masked output, join reasons, snippet) | F16 | 250 |
| P15 | export integration: `buildExport` adds `people` (excluded filtered), `llms.txt` People section; privacy tests | F14 | 220 |
| P16 | people `pack.ts`: episodes, budget trimming, neutralisation | F14 | 250 |
| P17 | people `prompt.ts` + `people-style.md` + `PersonDraft` schema; `write/index.ts` re-exports (R31) | F14 | 200 |
| P18 | people `verify.ts`: commit-only citations, authorship, R18 checks | F14 | 280 |
| P19 | people `write.ts`: batch and retry rounds through `write/rounds.ts`, journal, computed-lead fallback; test provider, then one recorded cassette (live, about $0.01) | F14 | 260 |
| P20 | people `update.ts`: due detection, append request, carried chronicle; append cassette (live, about $0.005) | F14 | 250 |
| P21 | `wiki:people` script: args, estimate, `--max-usd` selection (R26, C12), `--dry-run`, `--only`, `--disable`, `--forget <match-key>`, lock, summary | F14 | 290 |
| P22 | `wiki:update`/`wiki:replay` People step after M10's in-flight step (C14) and `--people-max-usd`; `wiki:check` re-verifies person revisions | F14 | 250 |
| P23 | The work-in-flight author join (C8): `Author.person` (default null), `buildExport` resolving M10's authors through `resolvePerson` (excluded → `null`), person links on the in-progress pages; `wiki:check`'s email scan; `describeError` email redaction | F14, F16 | 260 |
| P24 | site `activity-svg.ts` (bars, stacked bars, heatmap, a11y table, `xmlText`) + `/special/activity/` routes | F15 | 290 |
| P25 | site `/people/` and `/people/<id>/` pages, redirects, nav link (last, C10), Pagefind; the ask client's link pattern gains `/people/<id>/` (C9); crawl and CSP tests | F14, F15 | 290 |
| P26 | site: feature-page Main contributors row (`data-pagefind-ignore`) and the `/people/` by-feature table (`contributorsOf`) | F14 | 180 |
| P27 | `eval:accuracy` covers person pages: their claims join the accuracy sheet (§15 criterion 4) | F14 | 120 |

Twenty-seven tasks. Earlier-milestone dependencies: P4 and P9 follow M10's enum values and
migration 9 (C2, C6); P22 hooks in after M10's update step (M10 T12); P23 needs M10's `Author`
schema and in-progress pages (M10 T2, T13); P25 edits M9's ask client (M9 task 15).

**Live gate (after P27, controller-run, about $0.15).**

- `wiki:people` on a scratch copy of next-chief-of-staff's store, with a one-entry people file.
- `wiki:people` on RepoWiki's own store.
- `wiki:update` across one new merge.
- Record the numbers in the P27 PR and run the owner's review (§15).

## 15. Exit criteria

1. **Identity.** On next-chief-of-staff:
   - automatic grouping yields 8 human groups and 1 bot, with `seanpatrickmay` and `Sean May` merged and no false merge (owner-confirmed);
   - `people:suggest` lists the handle and full-name pair as a suggestion;
   - with that one entry, there are 7 person pages.
2. **Privacy.** The automated scan finds 0 author emails, or their local parts, in the export, `llms.txt`, the built site, summaries and command output for both gate repositories. An excluded test person leaves no trace.
3. **Verification.** Every stored narrative claim passes `wiki:check` (0 problems). Every chronicle claim carries a date inside its citations' range. At most 10% of claims are dropped in the first run.
4. **Accuracy.** The owner reviews his own page and two others with the M7 accuracy sheet (`eval:accuracy` extended to person pages): at most 1 false claim per 50 reviewed (the v1 §9 bar).
5. **Determinism and hermeticity.** The snapshot is byte-identical across two runs. The hostile-config blame test passes.
6. **Cost and time.**
   - The first `wiki:people` on next-chief-of-staff costs at most $0.25, with the estimate printed before any call.
   - An update in which no human with a narrative has new commits makes 0 People calls.
   - The first blame is under 60 s, and an update's refresh is under 5 s.
7. **Site.**
   - Every chart renders with JavaScript disabled.
   - The crawl finds no broken zoom link.
   - The CSP and the dependency list are unchanged.
   - Each feature page with blamed lines shows Main contributors linking to existing person pages.

## 16. Dependencies on the other v2 sub-projects

All three earlier milestones have merged when M11 starts.

- **#9 Work in flight (M10).**
  - People provides `resolvePerson(store, { login?, name?, email? })` (§6) and permanent `/people/<id>/` URLs.
  - M10 exports `Author { login, bot } | null` for each open PR and issue, with authors as plain text. P23 adds the join, in People's own `buildExport` step (C8): when People is on, each author whose login resolves to a person gains `person` (a new field, default `null`, C5) and the site links it; an author resolving to `{ kind: "excluded" }` is exported as `author: null` ("unknown author"), so an excluded person's GitHub login never appears beside work in flight; a bot keeps its badge; a login that resolves to nobody stays plain text. The join runs at export time, so a people-file change applies at the next export without an in-flight refresh.
  - Nothing prints an email.
- **#5 Agent interface (M8).**
  - People provides `WikiExport.people` (additive, `null` when off) and core's `contributorsOf()`, so a later tool ("who worked on feature X", "what did person Y do") can read the export and never git. No such tool is in v2's tasks, and M8's tools print no author (C8, C9).
  - Such a tool must treat names and narrative text as untrusted data, as with page text, and must not need person-revision history (R27); if it does, it adds an export field through the same additive pattern.
- **#4 Ask sidebar (M9).** Person pages are in Pagefind and in the export, but not in `@repowiki/query`'s index, so served answers never cite them (C9). The static-mode client lists Pagefind results, so P25 widens its link pattern (#4 R19) to `/people/<id>/`. It cannot surface an excluded person, because the export has none.
- **Shared constraints** (C2, C5, C6, C10).
  - People appends migration 10; work in flight's is 9. None renumbers a shipped one.
  - People adds `WikiExport.people`, `Author.person`, `LlmRole` `people` and `RunKind` `people`; M9 added `ask` and M10 `inflight` to the same enums. No `SCHEMA_VERSION` bump.
  - The Layout nav gains **People**, last; the header (M9's Ask button) is untouched.

## 17. Out of scope (v2 People)

- Per-claim line authorship on feature pages ("who wrote the lines this claim cites").
- Person-page history views (R27).
- Hover previews for person links.
- Co-author credit (R5).
- Collaborator graphs between people.
- Per-feature activity charts.
- GitHub API data: avatars, profiles, review counts.
- Drag-to-zoom and client-side charts.
- People across repositories (#8).
- Human edits to person pages (#7).
- SHA-256 repositories (as in v1).

## 18. For the owner

The decisions you are most likely to want to change:

1. **R16, voice.** "War chronicle" became a sober dated chronicle with no martial metaphor and no other people named. If you want more colour, it is a style-guide and banned-word change plus one cassette re-record. ADR-0007 records the reshape (C1).
2. **R15 and the privacy defaults, narratives about teammates.** Every human with at least 3 commits gets a narrative unless excluded. You might prefer an opt-in list (`narrate: [ids]`) on repositories you share with others.
3. **R1, blame is in.** It answers "who wrote what exists now" for about 30 s once per wiki. Dropping it removes only the current-lines and share figures.
4. **R5, co-authors ignored.** `Co-authored-by` trailers earn no credit, which matters for pair-programmed work. In your repositories the trailers are mostly AI models.
5. **R24, opt-in and no per-step replay narratives.** People is off until `wiki:people` runs, and replay writes narratives only at its end, so person pages have no dated revision history from replay.
6. **R12, exclusion beats URL permanence.** An excluded person's page vanishes without a redirect.
7. **R8, no fuzzy auto-merge.** Handle-to-name matches are suggested, not applied, so your repository needs one people-file line for its one handle.

## Cross-spec rulings (consistency review, 2026-10-04)

The four v2 specs (#5 Agent interface M8, #4 Ask sidebar M9, #9 Work in flight M10, #6 People
M11) were reviewed together after they were written. These rulings bind all four and appear word
for word in each; sections above that said otherwise were edited to agree. Each is "ruling — why —
cost if wrong".

- **C1 ADR numbers, in milestone order.** ADR-0004: hand-rolled stdio MCP (M8 task 1). ADR-0005:
  work in flight reads GitHub through `gh` (M10 T1). ADR-0006: blame for People, superseding
  ADR-0003, whose status P1 sets to "superseded by ADR-0006" (M11 P1). ADR-0007: the F14 chronicle
  voice (M11 P1). M9 writes none, since F09 is built as v1 §3 states it. — Numbers are taken in
  merge order. — None.
- **C2 Store migrations.** `main` ships 8 (`MIGRATIONS` has 8 entries; `user_version` 8).
  Migration 9 is work in flight's three tables (M10 T3); migration 10 is People's four tables and
  salt (M11 P9). M8 and M9 add none. — Merge order; both are additive SQL and rewrite no stored
  body. — None.
- **C3 One shared retrieval package, `@repowiki/query`, created once in M8 task 2.** Its runtime
  dependencies are `@repowiki/core` and `zod` only; its sources import no `engine` or `llm`, spawn
  no process and touch no network (a boundary test); `engine`'s test-repo is a devDependency for
  the moved `test-wiki` fixture. M8 contents: `text.ts`; `tools.ts` (`defineTool`, `toolSet`,
  `ToolError`, `MAX_TOOL_RESULT_CHARS`, a local `ToolDefinition` shape); `search.ts` (`terms`,
  `searchIndex`: BM25F); `wiki-view.ts` (`WikiView`, `ABOUT_PAGE_ID`, `listedPage`, `reference`);
  `wiki-page.ts` (`readPage(view, id, max, options?)`); `wiki-tools.ts` (`createWikiTools`);
  `as-of.ts` (`parseAsOf(text, resolveCommit)`, `revisionAt(revisions, asOf, isAncestor)`,
  `architectureAt`, `viewAt`, with git passed in as functions); `changes.ts`; `load.ts`
  (`loadExport`); `test-wiki.ts`. Everything that runs git or engine code lives in
  `@repowiki/mcp` (M8 task 4; depends on `core`, `engine`, `query`): the git helper moved out of
  eval's `repo-tools.ts`, `code.ts`, `head-status.ts` and `agent-tools.ts`. M9 adds to `query`,
  opt-in with every default unchanged: `claim-index.ts`, a handles option of `readPage`
  (`readPageWithHandles`) and `hrefs.ts`. M10 T15 uses `searchIndex` and `terms` for issue
  evidence, but `engine` never depends on `query`: `mapIssues` takes a `suggest` function that
  `scripts/` builds from `query` (both of #9's callers are scripts, C14), so there is no package
  cycle. M11 adds nothing to `query`. No later milestone re-extracts or falls back to extracting.
  — The ask must not load `engine`, and an `engine → query → engine` cycle is avoided. — A later
  `query` function that needs git takes it as a parameter, as `isAncestor` does.
- **C4 Byte-stable defaults.** `query`'s default `search`, `read_page` and `list_pages` text is
  pinned by the M7 and M8 eval cassettes and, from M9, by the ask's answer cache. A PR that changes
  a default output re-records the affected cassettes and bumps `ASK_PROMPT_VERSION` in the same
  PR. Adding a page kind to `query`'s index is such a change. — One retrieval for eval, agent and
  sidebar means one change reaches all three. — A missed bump serves answers rendered from the old
  output until "Ask again".
- **C5 `WikiExport` stays schema 3.** M10 adds `inflight: InFlight | null` and M11 adds
  `people: PeopleExport | null`, both defaulting to `null`; M11 also adds `person: PersonId | null`
  (default `null`) to M10's `Author`. M8 and M9 add no export field. Every earlier schema-3 export
  parses and `SCHEMA_VERSION` is not bumped. — The pattern `architecture` and `runs` set. — None.
- **C6 Roles, run kinds, models, prices.** `LlmRole` gains `ask` (M9 task 2), `inflight` (M10 T2)
  and `people` (M11 P4), each with its `DEFAULT_MODELS` entry (`claude-haiku-4-5`) in the same
  task, since `ModelConfig` is a record over `LlmRole`. `RunKind` gains `inflight` (M10 T2) and
  `people` (M11 P4). The ask (M9) and the eval agents (M8) record no run kind: their ledgers stay
  in memory and never reach the store. `pricing.ts` does not change; a role moved to an unpriced
  model is refused before any call. — Widening an enum rejects no stored row, so no migration. —
  None.
- **C7 Run totals.** `WikiExport.runs` sums store ledger rows by `(runKind, sha)`, so it gains one
  `inflight` total and one `people` total per wiki head (every refresh at that head summed). People
  calls made inside `wiki:update` and `wiki:replay` carry `people`, never `update`. The eval's
  break-even uses the last `build` run and the replay invariant compares `update` runs, so neither
  counts in-flight or People spend. — v1 §6.4 measures v1's pipeline. — None.
- **C8 Identity.** M8 and M9 print no author identity of their own; they print wiki text (claims,
  titles, commit subjects) through `query`'s neutralisation. M10 exports the GitHub logins of open
  PR and issue authors (validated, never emails); they are the only logins in the export. When
  People is on, M11 P23 resolves each in-flight author in `buildExport` through `resolvePerson`: a
  person gains `person` and the site links `/people/<id>/`; `{ kind: "excluded" }` exports
  `author: null` ("unknown author"), so an excluded person's login never appears; a login that
  resolves to nobody stays plain text. The join runs at export time, so a new exclusion applies at
  the next export without a re-derive. Exclusion removes People's own output; repository text
  (commit subjects in citations, PR titles) is not rewritten, and `wiki:people` says so when it
  excludes someone. — `resolvePerson` is the one identity map. — A login that no people-file
  `login:` key or noreply address names is shown unlinked.
- **C9 Search and indexes.** `query`'s index (MCP `search`, the ask's page search and claim index)
  covers active feature pages and the About article through M11. In-flight data is never indexed:
  in-flight pages carry no `data-pagefind-body`, and on articles the In progress section, claim
  markers and notice carry `data-pagefind-ignore="all"`. Person pages are in Pagefind (M11) but not
  in `query`; the Main contributors row carries `data-pagefind-ignore`. M11 P25 widens the ask
  client's link pattern (#4 R19) to `/people/<id>/`, so static-mode results can link person pages.
  An MCP or ask view of in-flight or People data is a follow-up outside v2's tasks; if built,
  in-flight output is labelled "open work, not merged code". — Answers and search results stay
  code-backed, and GitHub text never enters an index. — "Who worked on X" is not answerable by the
  agent or the sidebar in v2.
- **C10 Site shell.** The CSP meta is unchanged by all four. `wiki:serve` sends the same policy
  plus `frame-ancestors 'none'`, built from one exported constant that `Layout.astro` also renders
  (M9 task 13), so the two cannot drift. Only M9 adds to the header (the Ask button, after the
  search form). Nav order: Main page, Random article, All articles, About <project>, In progress
  (M10, when `inflight` is set), People (M11, when `people` is set). Claim anchors
  (`id="claim-<id>"` from core's `claimAnchor`) are added once, in M9 task 6; M10 links to them.
  Each milestone regenerates site snapshots on top of the previous one's merge. — Shared files are
  edited in milestone order. — None.
- **C11 One local server; out-dir names.** The only HTTP server is `pnpm wiki:serve` on
  `127.0.0.1` (default port 4321, also `site:preview`'s, so one runs at a time; a busy port names
  `--port`). The MCP server is stdio and opens no port. M10 and M11 add no server, and `wiki:serve`
  never reads GitHub or runs blame. Under `<out>/`: v1's `wiki.db`, `export.json`, `llms.txt`,
  `site/`, `eval/`; M8 `eval/history-<time>/`; M9 `ask/answers.jsonl`, `eval/ask-<time>/`; M10
  `inflight.git/`; M11 `people.json`, `people-<sha7>.md`. `site:build --no-inflight` refuses the
  default `<out>/site/`, which `wiki:serve` rebuilds with in-flight data; a build to share goes to
  another `--out`. `llms.txt` lists no in-flight data; M11 adds a People section. — No two features
  claim a port, a process or a path. — None.
- **C12 Cost rules.** Every paid command prints its estimate before the first call and needs a key
  only when the estimate shows calls. `--max-usd` is a ceiling counted at each call's upper bound:
  independent units (questions, PR summaries, narratives) are taken in priority order while the
  next fits, and the rest are reported as over budget and stay due. Defaults: `eval:run` $5 (M7),
  `ask:eval` $1.50, `wiki:serve` $0.05 a question and $1 a session, `wiki:inflight` $1,
  `wiki:people` $1, and the People round of `wiki:update`/`wiki:replay` $0.50
  (`--people-max-usd`). Rounds whose calls do not wait on each other are batched; interactive tool
  loops (eval agents, the ask) are not. A `cacheKey` is set only when an estimated prefix of at
  least 4,096 tokens is shared by at least two calls of one round: People (≈5,000) qualifies; the
  ask (≈3,000) and in-flight summaries (≈2,500) never do; the MCP server makes no call. — One rule
  the owner can predict. — None.
- **C13 Safety and hermetic git.** Untrusted text is neutralised on every path out (each spec's
  table). Nothing is written inside the documented repository: every output goes through
  `resolveOutDir`, and M8 and M10 tests compare a listing of the fixture's `.git` before and after.
  Every git process runs with engine's `scrubbedGitEnv()` (redirection, diff-shaping, pathspec and
  `GIT_CONFIG_*` injection stripped; `GIT_NO_LAZY_FETCH=1`), so hardening goes in argv `-c`, never
  the environment. M8 adds `GIT_OPTIONAL_LOCKS=0`; M11 pins blame's config (#6 R2). M10, the only
  network path: every command in `<out>/inflight.git` also sets `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_TERMINAL_PROMPT=0`, so a user's `url.*.insteadOf` cannot
  turn the built https URL into SSH and no global hook, merge driver or credential helper runs; an
  inherited `GIT_ALLOW_PROTOCOL` is kept and overrides `protocol.*.allow`, so a value without
  `https` (process tests set `file`) disables the fetch and heads report `missing`.
  `GIT_NO_LAZY_FETCH` leaves the explicit fetch alone, but a partial-clone documented repository's
  missing object becomes an error rather than a fetch: that PR is `missing`, and `inflight.git` is
  rebuilt at most once per run. — One git rule everywhere. — An owner who relies on a global
  `http.proxy` sets `HTTPS_PROXY` instead.
- **C14 Update and replay.** After v1 §6.1 (pages, then the About article), `wiki:update` runs the
  in-flight offline re-derive (M10, no call), then the People refresh and due narratives (M11),
  then writes `export.json` and `llms.txt` once. `wiki:replay` runs both once, at the head it
  reached, never per step, dropping the PRs merged by every step. Both hooks live in `scripts/`
  (`update-run.ts`, `wiki-update.ts`, `wiki-replay.ts`), so engine's `freshness/update.ts` is
  unchanged. #9's prediction check (R22) is written only for a run of one step that starts at the
  snapshot's `wikiHead`. — A per-step re-derive costs minutes for a state the next step replaces. —
  None.
- **C15 Each piece is built once.** The `query` extraction is M8's; claim anchors are M9's; each
  enum value, model default, ADR and migration belongs to the task named above. Later milestones
  name these as dependencies and do not repeat them.

## Review notes (consistency review, 2026-10-04)

Fixed in this spec:

- ADR-0004 and ADR-0005 collided with M8's ADR-0004; they are ADR-0006 and ADR-0007 (C1). The
  migration is 10 (C2).
- R10 said logins appear only in `people:suggest`, but M10 exports open PR authors' GitHub logins;
  R10 is scoped to the logins People derives, and the excluded case is handled by C8.
- Goal 2 and R12 promised an excluded person appears nowhere, but commit subjects (GitHub's
  "Merge pull request #N from <login>/<branch>") and PR titles are repository text RepoWiki does
  not rewrite; both now say so, and `wiki:people` tells the owner.
- R26 refused the whole run when the estimate passed `--max-usd`, while #9 selects within its cap;
  both now select by rank (C12).
- P22 bundled the update step, `wiki:check`, `describeError` redaction and the #9 author join;
  it is split into P22 and P23. §15.4 relied on an `eval:accuracy` extension no task built; P27
  adds it. The table gained sizes and explicit dependencies on M9 and M10.
- §2 promised that agents and the Ask sidebar answer "who worked on X"; no task in any milestone
  did that, so it is now a follow-up (C9). Person pages enter Pagefind, so P25 widens the ask's
  static-mode link pattern.
- Nav order and the Main contributors row's search exclusion are fixed (C9, C10).

Flagged, not changed:

- §15.1's counts (8 human groups, 1 bot, 7 pages) come from the spec writer's reading of
  next-chief-of-staff; the owner confirms them at the gate.
- §15.6's time bars depend on the machine; they are measured on the owner's.
- The exclusion privacy test needs a fixture whose commit subjects do not name the excluded
  person, or it fails by C8's carve-out.
- Narratives about every teammate with 3 or more commits are on by default (R15, §18.2). On a
  shared repository such as next-chief-of-staff, the owner should decide this before the live
  gate.

## 19. M11 plan deltas (2026-10-06)

The M11 plan (`docs/superpowers/plans/2026-10-06-repowiki-m11-people.md`) changes this spec
as follows; where a line above disagrees, this section wins. Its rulings R1-R40 settle what this
spec left open.

- **§14 (tasks).** Thirty-seven tasks instead of twenty-seven: P1-P18 keep their scope as Tasks 1-19, with P10's identities and P14's suggest command split so `refresh.ts` (Task 14) joins the read and the store write; P19 is split into the scripted round (Task 20) and the recording (Task 22), which also records P20's append; P20's due detection is Task 21; P21 is split into the flags and summary (23), the engine round (24), the People step shared with the update (25) and the command (26); P22 into the update hook (27) and `wiki:check` (28); P23 is Task 29 with the email scan moved to 28; P24 into the bar charts (30), the heatmap, sparklines and repository series (31) and the zoom pages (34); P25 into the view models (32, which also take P26's `/people/` by-feature table) and the pages (33), with the ask client's link pattern moved to 35; P26 is 35 with the in-flight author links; P27 is 36; the live gate and runbook are Task 37.
- **R2 (blame argv).** No `--end-of-options` (git blame reads it as a revision and fails with "bad revision"); the sha is checked as 40 hex instead. `--ignore-revs-file=` replaces `-c blame.ignoreRevsFile=`, which does not clear a file the repository's own config names. `--no-textconv` is added.
- **R15 and §2, §18.2 (consent).** Narratives are off by default: only the owner (the people file's `owner` keys, else the documented repository's configured `user.email`) and people whose entry says `narrative: true` get one; `PeopleEntry` gains `narrative` and `PeopleConfig` gains `owner` and `humans`. On next-chief-of-staff, the 7 person pages have narratives only as the owner grants them. A withdrawn consent deletes the stored narrative at the next refresh (it is not kept until `--forget`, unlike an exclusion's).
- **R26 (keys in updates).** `wiki:update` and `wiki:replay` print the People ceiling up front but the People estimate only after the refresh, since the due set is known only at the new head; with no key the due narratives are listed and stay due, and the update exits 0. `wiki:people` checks the key once, after its estimate and before its first call.
- **§8.5 (costs).** The recording is one task (Task 22), unbatched, about $0.03 for the build and the append; the live gate runs on RepoWiki only, about $0.05.
- **§10.** `wiki:people --dry-run` works on a copy of the store, so it writes nothing and prints the table and the estimate; `--disable` and `--forget` each stand alone; `--forget` prints counts only. `people:suggest` also works on a copy.
- **§6 (resolvePerson).** It is `Store.resolvePerson`, the oldest registry row holding a salted key of the login, name or email; core gains `saltedKey` and `queryKeys` so the store needs no People module.
- **C1 (ADR numbers).** M10 shipped ADR-0006 (`inflight.git` borrows objects), so People's ADRs are ADR-0007 (blame for People, superseding ADR-0003, whose status reads "superseded by 0007") and ADR-0008 (the chronicle voice); where this spec says ADR-0006 or ADR-0007 for People, read ADR-0007 or ADR-0008.
- **§11 (site).** The "N newer commits are not yet in the narrative" line counts commits on days after the narrative's commit date and shows whenever that is above 0 (R35). M10's in-progress pages call a null author "an unknown author" (R36). The People and zoom routes build nothing when the export has no People (R33).
- **R10 (masked emails, fix-forward).** `people:suggest` masks an address to at most the first character of its local part (nothing of a local part under three characters), then `…@` and the domain, both stripped of control and invisible characters. Its merge snippet takes name keys only from names that clean to something, and says to add by hand the other keys of a person with a name that gives none. Every other part of its output passes `withoutEmails`. A people file that is a broken link or unreadable is a usage error (exit 2), and the throwaway store copy lives under the out dir (`<out>/.people-scratch-*`), never TMPDIR.
- **C13 (the People log, fix-forward).** `readAuthorship` runs `git --no-replace-objects --attr-source=<sha> -c core.fsmonitor=false -c core.attributesFile=/dev/null -c core.bigFileThreshold=512m -c i18n.logOutputEncoding=UTF-8 -c diff.renames=true -c diff.renameLimit=1000 log -z -M --root --numstat --diff-merges=off --diff-algorithm=myers --no-show-signature --no-color --no-ext-diff --no-textconv`, then its format and the sha, so its counts follow the sha, not the repository's config, replace refs or work tree. `--attr-source` is passed on git 2.40 or later only (detected once); on 2.38-2.39 the People summary notes that attributes from the work tree may apply. The log has a 10-minute timeout and a 256 MiB output cap, each a GitError.
- **R2 (blame argv, fix-forward).** Blame also passes `-c blame.ignoreRevsFile=` and `--indent-heuristic` (a configured `diff.indentHeuristic=false` moved lines between authors): `git -c core.fsmonitor=false -c blame.markIgnoredLines=false -c blame.markUnblamableLines=false -c diff.algorithm=myers -c blame.ignoreRevsFile= --literal-pathspecs blame --incremental --ignore-revs-file= -C -C -M --diff-algorithm=myers --indent-heuristic --no-textconv [--ignore-rev <sha>]… <sha> -- <path>`. git opens every configured ignore file before either flag clears it, so a configured file git cannot read, a cause `gitFailureCause` names, or output past the cap leaves that file's lines unattributed, with one warning per cause, and never aborts People. The hermetic test's fsmonitor canary is replaced by a textconv canary (blame at a sha runs no fsmonitor hook).
