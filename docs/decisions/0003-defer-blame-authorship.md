# 0003. Defer line authorship by git blame (F17) to v2

- Status: accepted
- Date: 2026-10-03
- Features: F17

## Context

F17 split "as-is vs full history" in two: line authorship from `git blame -C -C -M`, which follows
copies and moves, and article history from replaying merges (spec §6.2). M6 builds the replay. No
v1 reader view shows who wrote a line: the infobox shows first and last commit dates, history
claims cite commits, and the eval's "what changed when" questions are answered from the dated
history. Blame would cost a run per cited file per update and a cache to keep current, for nothing a
reader of v1 sees.

## Decision

v1 computes no line authorship. F17 is met in v1 by the dated history replay produces. Blame is
reconsidered in v2 if a reader view needs it, such as who wrote the lines a claim cites.

## Consequences

No authorship is shown in v1, so none can be misattributed by a copied file. The spec's F17 row
says the blame half is deferred. Nothing in M6 depends on it.
