# 0001. Analysis-first pipeline with an LLM-maintained manifest

- Status: accepted
- Date: 2026-09-30
- Features: F03, F04, F05, F26

## Context

Pages are scoped by feature, not folder (F04). Feature boundaries are a judgment call, and an LLM that
re-derives them on every run splits and merges differently each time, which breaks URLs, links, and
history. Freshness (F05) must be cheap enough to run on every merged PR.

## Decision

Deterministic analysis first: tree-sitter symbols, an import graph, and git co-change are combined into
one weighted graph and clustered. The LLM names, merges, and splits clusters into a manifest with permanent
feature IDs, and on later runs it updates that manifest with explicit operations instead of rebuilding it.
Articles are stored as claims whose code citations carry a content hash, so staleness is computed from
diffs, not judged by an LLM.

Rejected: a free-roaming agentic explorer (unstable page identity, expensive freshness, hard-to-verify
citations) and an LLM-only feature proposal from a repo map (loses the co-change signal).

## Consequences

More engineering up front (indexer, clustering, verifier). Most updates need no LLM call at all when
cited code is unchanged. Merges and splits become redirect and disambiguation pages, so no URL breaks.
