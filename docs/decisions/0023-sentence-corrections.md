# 0023. Correcting a sentence

- Status: accepted
- Date: 2026-10-22
- Spec: `docs/superpowers/specs/2026-10-22-sentence-corrections-design.md`
- Amends: ADR-0012 (what an author may change), Contract §6.1 (a third job kind), §7.1 (a new
  action), §10 (plan limits), §11 (a new refusal)

## Context

ADR-0012 ruled that every word on a page is generated, so an author who finds a wrong sentence
could only rebuild or write to support. Both persona rounds named this as the gap that matters
most. On 2026-10-22 the owner approved a correction that keeps ADR-0012's rule: the author flags
a sentence and says why, RepoWiki rewrites it from the code it cites or removes it, and the note
never appears anywhere.

## Decision

- **A third job kind, `correct`, and the action `job.correct`.** Ruling: a correction starts from
  the project's latest generation and needs a draft to correct, a live eligibility check (it
  clones the repository) and room in the month's cost, like a refresh. It is frozen with the rest.
  — The same gates as any job that spends money. — Cost if wrong: one branch in `authorize`.
- **Limits.** Ruling: Free gets 3 correction jobs for each project, Pro 20 a month across its
  projects, with those in flight counted. A job that changes nothing fails, and a failed job counts
  for nothing. A new refusal, `plan-correction-limit`, says so. — Corrections are cheap (one small
  call per article flagged) but not free. — Cost if wrong: two numbers in `PLANS`.
- **Rebuilds.** Ruling: a correction's revision is no rebuild. Free's one rebuild before
  publishing counts the project's revisions past the first, less its succeeded corrections. —
  Fixing one sentence must not cost the student their rebuild. — Cost if wrong: one subtraction.
- **What changes.** Ruling: only the flagged sentences, each rewritten under the citation checker
  or removed; a lead left summarizing nothing goes with it. Every word is still generated and
  cited. — ADR-0012 stands. — Cost if wrong: none.
- **The note.** Ruling: the note reaches only the model. It lives in the job's spec until the job
  ends, then is deleted; it is never in an export, a page, an audit entry or a log line. — It is
  the student's private text. — Cost if wrong: a note kept a few minutes longer than needed.

## Consequences

- `Usage` counts correction jobs; the policy context carries the project's own count.
- The engine's `correctClaims` and `pnpm wiki:correct` do the work; the worker and server follow.
