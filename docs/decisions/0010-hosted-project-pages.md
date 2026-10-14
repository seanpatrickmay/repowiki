# 0010. Host project pages for any developer's public repositories (F26)

- Status: accepted
- Date: 2026-10-14
- Features: F26
- Amends: 0009 (its statement of the owner's goal; the shelving of F07, F08 and F09 stands)

## Context

ADR-0009 described the owner's goal as narrow: build wikis for his own repositories and link them
from his website as static files. On 2026-10-14 the owner widened it. RepoWiki becomes a hosted
service where any developer signs in with GitHub, turns one of their public repositories into a
project page, reviews it and publishes it at a stable URL for their resume, with a public profile
collecting their pages. The first readers are recruiters and hiring managers.

Two unfinished prototypes of this were written in `packages/site` on 2026-10-14 without an issue,
ADR or tests for most of their code, and the worktree failed typecheck. They are archived on branch
`archive/hosted-prototype-2026-10-14` and do not merge.

## Decision

Build the hosted product as four specs, each with its own plan: the Contract (a pure
`packages/hosted` library of entities, transitions, authorization, URL rules, limits and refusals),
a vertical slice (sign-in, eligibility, sandboxed generation, review, publish, public pages), safe
operation (quotas, ledger, lifecycle jobs, deletion, backups) and billing. Public sign-up opens only
after the last two.

The owner settled the product rules (Contract spec §3):

- Eligible repositories are public, not forks, pushable by the user and holding at least one of
  their commits; checked at job creation and again at publish.
- A page shows the author's reviewed contribution statement beside git-history facts they cannot
  hide. No skill, seniority or proficiency is inferred.
- Free: one project and one generation. Pro at $5/month: ten projects, ten generations and thirty
  refreshes a month, with a $4 model-cost ceiling. A $25/day platform cap protects the free tier.
- Published links never break on downgrade and are never reassigned; withdrawn pages answer 410.
- Hosting is Fly.io, Neon Postgres and Cloudflare R2 under RepoWiki's own domain, with an offline
  analysis sandbox and an LLM proxy that holds the key and enforces cost caps; portable seams keep
  a later move to AWS small.
- Authors edit only the portfolio layer, never wiki prose; refresh is manual.

The engine and the static site are reused unchanged: a hosted job runs the existing pipeline and
the site package renders the published version.

## Consequences

- RepoWiki now handles other people's accounts, repositories and money, so authorization,
  isolation of untrusted repositories, cost ceilings and data retention become first-class
  requirements with tests, not later hardening.
- `packages/hosted` joins the workspace; later specs add a server, a worker and a proxy package.
- F18 (human edits to the wiki) stays deferred: the portfolio layer is the only editable text.
- F09, the Ask sidebar, stays shelved; a hosted server could serve it later, but nothing in this
  decision needs it.
- The owner's own wikis at `seanpatrickmay.me/wiki` keep working as before.
