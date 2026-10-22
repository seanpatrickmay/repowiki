# Sentence corrections — design

- Date: 2026-10-22
- Status: approved by the owner in conversation ("Yes" to: a student flags a wrong sentence,
  RepoWiki rewrites it from the cited code or drops it, the note never appears)
- Amends: Contract §6.1 (a third job kind), §7.1 (a new action); ADR-0012 (what a student may
  change: still nothing by hand)

## Purpose

Both persona rounds named one gap above all others: a student who finds a wrong sentence can only
rebuild once or email support. This design lets them flag the sentence and say why. RepoWiki then
rewrites that claim from the code it cites, with the note as a hint, and verifies the rewrite like
any other claim. A claim that cannot be supported is dropped. Every word on a page is still
generated and cited (the owner's 15 October ruling), and the note is never shown.

## What the student does

1. On a project with a draft, the project page links **Correct a sentence**
   (`/projects/:id/corrections`). It lists the draft's articles, About article included.
2. An article (`/projects/:id/corrections/:page`) lists its sentences in page order, each with a
   checkbox and a short "What's wrong?" box (500 characters).
3. The student ticks one or more sentences (at most 10 a job), writes why for each, and submits.
   A correction job starts, and the project page shows it like a build ("Correcting 3 sentences").
4. When it finishes, the draft is a new revision. Each flagged sentence was either rewritten or
   removed, and the page says which. The student previews and publishes as usual; the review
   declaration is asked again.

## How it works

- **Job.** A third kind, `correct`. Its spec names the generation it starts from (whose export is
  stored), and lists `{page, claimId, note}` items. Claim ids are stable within that export.
  Corrections apply to the latest revision only; a newer revision makes the request stale (409).
- **Worker.** It clones at the generation's commit, as a build does, then runs `wiki:correct`. It
  uploads the corrected export and succeeds. There is no manifest, wiki or people step, so it
  takes seconds.
- **Engine: `correctClaims`.** For each page with flagged claims it makes one model call
  (non-batch). The call gets the page as it stands, the flagged claims with their notes, and the
  numbered lines of every file the page cites at that commit. It answers, per flagged id, a
  rewritten claim (text and cite, same section) or `drop`. Each rewrite goes through `verifyClaim`
  against the commit, with one retry round for failures as in `rewritePages`. A claim whose
  rewrite does not verify is dropped. The page is reassembled with `pageSections`: ids renumbered,
  and leads that lose all support dropped. If no lead or body survives, the page keeps its old
  claims and the job says so. The About article's claims are corrected the same way through
  `verifyArchitectureClaim`.
- **Revision.** Each changed page gets a new stored revision with `reason: "correction"` (an
  added enum value; stored bodies still parse), `parentId` the old one. The export's head and
  manifest are unchanged.
- **Server.** On success the export becomes a new generation (same commit, same facts and
  suggestions as its parent), and `correctionRevision` makes a new draft revision. The project page
  reports each item's outcome: rewritten or removed.
- **The note** goes only to the model through the LLM proxy and into the job spec. It is never in
  the export, a page, the audit log or a log line, and it is deleted with the job spec at purge.

## Limits and cost

- One job in flight per project, as for builds. At most 10 sentences a job.
- Free: 3 correction jobs per project. Pro: 20 a month across projects. A job whose every item is
  refused or fails counts for nothing, as a failed build doesn't.
- Cost: one small Haiku call per article flagged, plus one retry. The job's cost cap is a tenth of
  a build's estimate.

## Out of scope

- Correcting a published revision in place. A correction makes a new draft, published as usual.
- Correcting the contribution paragraph or the biography's lead. Those come from facts and the
  About article, so correcting the About article corrects the lead.
- Free-text edits of any kind.

## Testing

- Engine: `correctClaims` against a cassette, covering a rewrite that verifies, a rewrite that
  doesn't (so the claim is dropped), a dropped claim whose lead loses support, and a page left
  unchanged.
- Hosted: the `correct` kind, the action's policy and its limits.
- Server: the routes, the stale-revision refusal, the new draft, and that the note never appears
  in a rendered page or the audit log.
- Worker: the `correct` path, with a fake engine.

## Rulings

- Each job holds at most 10 claims, so one request can't rewrite a whole page into something
  else. Cost if wrong: a student files two jobs.
- A rewrite that fails verification drops the claim rather than keeping it. The student said
  it's wrong, and the checker couldn't support a better one. Cost if wrong: a true sentence the
  model couldn't restate is lost. The student sees "removed" and can rebuild.
