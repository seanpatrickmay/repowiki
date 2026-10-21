# 0015. One free rebuild before publishing

- Status: accepted
- Date: 2026-10-21
- Amends: Contract spec D3 and §10 (Free plan limits)

## Context

D3 gives Free one generation, ever, and no refreshes. A student reviewing their only Free build
who finds it reads wrong can publish it, or unpublish it, or pay for Pro. A review of the sign-up
flow from a student's point of view named this as the point they would leave: one attempt, no
redo, no edits. Fixing the product's own output should not be a paid feature.

A build costs about $0.03 on Haiku 5.5 (AlphaSettler at baf5f69 measured $0.028), and every job is
a full build from a fresh clone, so a rebuild writes the entry again rather than patching it.

## Decision

- **Rule.** Ruling: Free may rebuild its project once while that project has never been published.
  The rebuild is a `refresh` job at the latest commit. — The owner's answer to the review. — Cost if
  wrong: one more build per Free account, about $0.03.
- **Counting.** Ruling: a never-published project's revisions past its first are its rebuilds,
  plus refreshes in flight, against `rebuildsBeforePublish` in `PLANS` (Free 1, Pro 0; Pro keeps
  its 30 monthly refreshes). A failed rebuild adds no revision, so it does not count, as D3 has
  it for every failed job. Once a project has a published version (`currentVersion > 0`) the
  allowance is gone, even after unpublishing. — No new counter or migration: the project row
  already holds both numbers. — Cost if wrong: a rule in `policy.ts`.
- **The page.** Ruling: the project page offers the rebuild after a build ends, with the line "Free
  includes one rebuild before you publish", and offers Pro "Refresh from the latest commit" the
  same way; `rebuildOffer` decides which, and `authorize` still decides each click. Before this,
  neither plan saw a refresh button after a successful build. — Cost if wrong: one button.

## Consequences

- Free's monthly cost ceiling ($1.00) covers two builds at the Free cap ($0.42 each).
- The Free project is still final: a rebuild is the same repository, not a swap.
