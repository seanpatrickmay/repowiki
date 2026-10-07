# 0005. Read GitHub through the owner's gh CLI

- Status: accepted
- Date: 2026-10-05
- Features: F23

## Context

M10 shows a repository's open pull requests and issues beside its wiki (spec v2 #9). That needs
two read-only queries per refresh (open pull requests with their head commit, labels, closing issues
and file list; open issues with their labels) and a fetch of each pull request's head. The owner's
repositories include private ones in an organisation that uses SSO, and RepoWiki stores no
credentials of its own. The choices were a GitHub REST or GraphQL client with a token RepoWiki
reads from the environment or a file, Octokit as a new dependency, or the `gh` CLI the owner
already has logged in.

## Decision

RepoWiki reads GitHub only by running `gh api graphql --hostname github.com` with its two fixed
queries (spec §5.3), and fetches pull-request heads with `git fetch` over https using
`gh auth git-credential` as the credential helper. It never reads, stores or prints a GitHub
token: `gh` keeps it in the owner's keychain. `gh` runs with argv only (no shell), with
`GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1` and `NO_COLOR=1`, with every `ANTHROPIC_*`
variable removed from its environment, a 60-second timeout and a 32 MiB cap on its output; its
stderr reaches the terminal only as its first line, redacted of token shapes. Only
`pnpm wiki:inflight` in online mode runs it. No `gh`, no login, a remote that is not github.com or
an API error is a skip: the command says why and exits 0, and the stored snapshot is kept.

## Consequences

No new dependency and no credential handling in RepoWiki; private and SSO repositories work
whenever the owner's `gh` can read them, and not otherwise (the owner grants that in GitHub, not in
RepoWiki). RepoWiki depends on `gh`'s `api graphql` interface and its exit codes (4 for "not logged
in"), which the tests pin with a fake `gh` and canned answers; a change there shows up as a skip
reason, not a crash. GitHub Enterprise, GitLab and Bitbucket stay out of scope (spec §13); a
second host would need its own reader behind the same `GitHubSource` interface.
