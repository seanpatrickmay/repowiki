# 0009. Shelve the Ask sidebar (F09) and the MCP server (F07, F08)

- Status: accepted
- Date: 2026-10-08
- Features: F07, F08, F09

## Context

The owner's goal for RepoWiki is now narrow: put their repositories into it, build each one's wiki
site, and link to those sites from a personal website. A linked site is static. The Ask sidebar
(M9, F09) needs `pnpm wiki:serve` running beside the site, with an API key and a live model call per
question, so it does nothing on a site served as plain files. The owner does not need it, and code
that stays on `main` has to be kept green, reviewed and paid for in check time.

The MCP server (M8: the part of F07 that serves a wiki to a coding agent, and all of F08, reading
the wiki as of a past date or commit) is the same case: the owner does not run an agent against
their wikis, and the server and the eval agents that measure it are the largest package left.

## Decision

The Ask sidebar comes off `main`. F09 is deferred, not rejected: the design and plan stay in
`docs/superpowers/` as history, and merging branch `ask/restore` brings the sidebar back as it was
at M11's end.

Removed:

- `packages/ask` (the turn-1 pack, the bounded tool loop, answer validation, the answer cache,
  session caps, the `/api/ask` handler, its cassette and its boundary test).
- `pnpm wiki:serve` (`scripts/wiki-serve.ts`, `serve-cli.ts`, `serve-static.ts`) and `pnpm ask:eval`
  (`scripts/ask-eval*.ts`), with their tests. `pnpm site:preview` stays for viewing a site locally.
- The site's sidebar: the header's Ask button, the panel (`AskPanel.astro`), `/special/ask/`, the
  Ask client (`client/ask.ts`, `client/ask-render.ts`, their DOM test double), the `.ask-*` styles
  and the site's package exports only `wiki:serve` imported.
- Core's Ask schemas and limits (`ask.ts`, `ask-limits.ts`, `makeAskResponse`); query's claim
  handles, claim search and answer links (`ask-page.ts`, `claim-index.ts`, `hrefs.ts`) and
  `readPage`'s `claimHandle` and `history` options.

Kept:

- `claimAnchor` (moved to `core/src/claim.ts`) and the site's claim anchors with their
  `:target` highlight: articles, the About article and the In progress page link to claims.
- `"ask"` in `LlmRole` and its default model, unused, so config files and ledger rows that name
  it still parse.
- The site format marker (`.repowiki-site`), Pagefind search, the CSP, and the llm package's
  forced tool choice and call timeout, which are not Ask-specific.

### The MCP server (F07's server half, F08)

The MCP server comes off `main` too. F08 and the server half of F07 are deferred, not rejected:
ADR-0004 (the hand-rolled stdio protocol) stays as the record of how it was built, and merging
branch `mcp/restore` brings the server back.

Removed:

- `packages/mcp` (the stdio JSON-RPC server, its client, the six agent tools, the as-of and
  freshness views, its git reads and their tests) and `pnpm mcp:serve` and `pnpm mcp:probe`
  (`scripts/mcp-*.ts`).
- What exists only to run or measure agents through the server: the eval's `mcp` and `repo+mcp`
  agents, `openMcpTools`, the M8 report section (`interface.ts`), the history suite (`--set
  history`, the `as-of` question kind and its smoke file), the `tool-failure` answer stop and the
  run's `halted` stop, the M8 smoke cassettes (`smoke-mcp.json`, `smoke-history.json`), and
  query's as-of views, page changes, `loadExport`, `combineToolSets`, `readPage`'s banner,
  freshness and claim-note options, `searchResults`' note and hint, and the history test wiki.

Kept, because v1 uses it:

- The v1 eval: `eval:run` with the wiki and repo agents, `eval:report`, `eval:accuracy` and its
  sheets (M11's `--person` included), and the `--agents` option, which now takes `wiki` and
  `repo`. The repo agent's read-only git runner (`runGit`, `topLevel`), which M8 had moved into
  `packages/mcp`, moves back into the eval as `packages/eval/src/git.ts`.
- `packages/query` for the eval, `llms.txt`, `export.json`, core's diff helpers (the site's diff
  view uses them) and the engine functions M8 exported for the server.

No stored run is lost: no eval run directory that names an `mcp` agent or the history set exists.

## Consequences

Every page's HTML loses the 22 lines of sidebar markup; nothing else on a page changes. A built
site needs no server. The specs and plans for M8 and M9 still describe the server and the sidebar
as shipped; this ADR is what says they are shelved. Restoring either is one merge, of
`ask/restore` or `mcp/restore`, each of which also marks its features restored here. A run.json
or question file that names an `mcp` agent or the history set no longer parses until
`mcp/restore` is merged.
