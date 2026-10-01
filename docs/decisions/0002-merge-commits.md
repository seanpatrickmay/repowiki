# 0002. Merge PRs with merge commits, never squash

- Status: accepted
- Date: 2026-09-30
- Features: F05, F06, F19

## Context

`repowiki replay` walks first-parent merge commits on `main` and reads the PR number from
`Merge pull request #N`. RepoWiki is meant to document itself, and its frequent small commits are part of
the history it documents.

## Decision

Every PR merges with `gh pr merge --merge`. Squash and rebase merges are not used.

## Consequences

`main`'s first-parent history is exactly one commit per PR, which is the unit replay expects. Branch
commits stay visible, so every one of them must pass `pnpm check` and have a clean message.
