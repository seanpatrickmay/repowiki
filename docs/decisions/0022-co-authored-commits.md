# 0022. Co-authored commits count for the people they name

- Status: accepted
- Date: 2026-10-22
- Amends: spec v2 #6 R5 (People reads trailers), ADR-0020 (contribution words)

## Context

Three personas said team credit was unfair, and /questions told them that squash-merged or paired
work "counts for whoever's name is on the commit". That overstated the problem. GitHub's squash
merge keeps the pull request's author as the commit's author, and writes a `Co-authored-by:`
trailer for each other person who committed to the branch. People read only the author, so
every co-author went uncredited.

## Decision

- **Reading trailers.** Ruling: `readAuthorship` reads each `Co-authored-by: Name <address>` line
  of a commit message (any case), each address once and lowercased, never the author's own. —
  It is git history, so the owner's rule that nothing on a page comes from anywhere else holds. —
  Cost if wrong: one parser.
- **Matching people.** Ruling: a trailer's address counts for the one person who committed under
  it; an address no commit used, or one two people share, counts for no one. — A trailer's name
  is free text, and an address that names no committer has no page to credit. — Cost if wrong:
  uncredited co-authors.
- **Counting.** Ruling: a person's `coAuthored` is the number of others' non-merge commits that
  name them, once per commit. It stays apart from `commits`, and lines stay with the commit's
  author. The field is written only when above zero, so stored snapshots are unchanged. — The
  commit counts and blame keep meaning what they say. — Cost if wrong: one optional field.
- **Words.** Ruling: the facts paragraph says "made N of the repository's T commits, was named a
  co-author of C more and was the last to change about X% of the code in it now". /questions
  and the home page say how credit follows commit names and trailers. — Cost if wrong: one
  sentence.
