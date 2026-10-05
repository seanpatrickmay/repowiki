# 0004. Hand-roll the stdio MCP protocol instead of taking the SDK

- Status: accepted
- Date: 2026-10-04
- Features: F07, F08

## Context

M8 serves a wiki to coding agents as an MCP server (spec v2 #5). The server speaks only stdio,
serves only tools, makes no LLM call and writes nothing. The official TypeScript SDK's 1.x line
ships its HTTP, SSE and OAuth stack as runtime dependencies (express, cors, ajv, eventsource,
pkce-challenge and more) that a stdio-only, tools-only server never loads. CLAUDE.md asks for every
dependency to be pinned and reviewed, and each of those would be. The part of the protocol the
server needs is small: JSON-RPC 2.0 over newline-delimited stdio with `initialize`,
`notifications/initialized`, `ping`, `tools/list` and `tools/call`.

## Decision

`@repowiki/mcp` implements that subset itself in `protocol.ts` and `stdio.ts` (about 250 lines),
tested from JSON-RPC transcripts, with no `@modelcontextprotocol/sdk` dependency. It negotiates the
protocol revisions it was written against (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05) and
answers any other request with the newest. A batch is refused, a notification never gets a reply,
an unknown method is -32601 and an unknown tool -32602. Nothing but protocol lines reaches stdout,
which a boundary test and the spawn tests check.

## Consequences

RepoWiki owns protocol compatibility: a later MCP revision that the server mishandles shows up in
the owner's Claude Code check (spec v2 #5 section 11.1) rather than in an SDK upgrade. Replacing
`protocol.ts` with the SDK stays one task behind the same `handle()` boundary, plus that SDK's
dependency review. No new third-party dependency is added in M8.
