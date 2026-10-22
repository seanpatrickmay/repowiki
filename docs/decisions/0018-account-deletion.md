# 0018. Deleting an account

- Status: accepted
- Date: 2026-10-22
- Implements: Contract §6.2 (`account-deleted`, purge), §7.1 (`account.delete`), §9 (tombstones)

## Context

The privacy page (ADR-0016) promises that a student can delete their account and that everything
RepoWiki keeps about them is gone within 30 days. The Contract already has the rules as pure
functions: `accountDeleted` withdraws a project and starts its purge clock, `purge` ends it, and
an account that is `deleting` may do nothing. Nothing in the server called them, so the promise
could only be kept by hand, which the owner ruled out (no manual overrides, 2026-10-15).

## Decision

- **Where.** Ruling: the app nav's "Billing" link becomes "Account": a page that shows the login,
  the page's URL and the plan (linking to Billing), and a "Delete your account" form that asks
  for the GitHub login to be typed. — Deleting is rare and permanent; typing the login stops a
  stray click. — Cost if wrong: a page.
- **What happens at once.** Ruling: in one transaction the account turns `deleting`, every project
  is withdrawn for `account-deleted` (its pages answer 410), every handle is tombstoned (410, never
  reassigned), and the account's sessions, GitHub token and preview links are deleted; the browser's
  cookie is cleared. — Everything public goes in the same moment, and nothing can act for the
  account afterwards. — Cost if wrong: none; the purge still runs.
- **Pro is cancelled first.** Ruling: a subscription Stripe may still charge is cancelled at once
  (not at period end) before anything is deleted; if Stripe refuses, nothing is deleted and the
  page says to try again. No refund is made automatically; the refund policy still applies on
  request. — A deleted account must never be charged again. — Cost if wrong: a student loses the
  rest of a period they paid for, which the refund policy can return.
- **A build in flight.** Ruling: deletion waits for a queued or running build to finish (409 with
  a message). — A worker would otherwise keep spending for an account that is gone. — Cost if
  wrong: a wait of up to half an hour.
- **Coming back.** Ruling: signing in again with the same GitHub account is turned away (410) and
  changes nothing; the account's GitHub user ID and login are kept, with its tombstoned handles, so
  no one can take over the deleted page's address and a returning person is recognised. A new
  account for the same GitHub user is not offered. — The Contract keeps one account per GitHub user
  and never reassigns a handle. — Cost if wrong: a student who deletes by mistake can't start
  again; allowing it is a migration (a partial unique index on active accounts).
- **The purge.** Ruling: 30 days after deletion a sweep in the server process purges each project
  (`purge`): its exports, previews and sites are deleted from the object store and its generations,
  revisions, reviews, previews and versions from the database; the project row and slug remain as
  the 410 tombstone. When none of the account's projects is left unpurged, the account's display
  name, avatar and billing row are removed too. Stripe keeps its own payment records. — The privacy
  page's promise, kept by code. — Cost if wrong: data kept longer than promised.

## Consequences

- The privacy page says what is kept after deletion: the GitHub user ID and login, so the address
  can't be reused, and Stripe's payment records.
- Purge also serves the Contract's other withdrawals (repository gone, author withdrew and the
  repository went away), which had the rule but no sweep.
