# 0021. Coming back after deleting an account

- Status: accepted
- Date: 2026-10-22
- Supersedes: ADR-0018's "Coming back" ruling
- Amends: Contract §6.2 (a purged project can start again), §9 (a tombstoned handle can return to its own account)

## Context

ADR-0018 turned a deleted account away for good when its GitHub user signed in again. The owner
called this strange, and it is. The two rules behind it don't require it: no one else may take a
deleted page's address, and there is one account per GitHub user. The returning person is the
same GitHub user, so giving them their own address back takes nothing from anyone.

## Decision

- **Signing in again.** Ruling: a deleted account signing in again becomes active, whatever the
  sign-up allowlist says (it was let in once). It gets back its handle: the tombstoned one for its
  current login, else its newest. — The same GitHub user, the same address. — Cost if wrong: one
  branch in sign-in.
- **Its projects.** Ruling: a project its deletion withdrew, and not yet purged, comes back as the
  author's own withdrawal (`accountReturned`). It is unpublished, its purge clock is stopped, and
  the author may publish it again or take it down. A purged project's data is gone. Building its
  repository again starts it over as a fresh draft with the same id, slug and address (`revive`).
  It counts against the plan like a new project. — Deleting is undone as far as the data still
  allows, and nothing comes back public without the author publishing it. — Cost if wrong: two
  transitions.
- **Allowances.** Ruling: nothing starts over. Jobs and the spend ledger are never purged, so
  Free's one project and the monthly counts carry on from before the deletion. — Deleting and
  coming back must not be a way to get a second free project. — Cost if wrong: none.

## Consequences

- /account, the deleted page and /privacy say what happens on coming back.
- Audit records `account.return`.
