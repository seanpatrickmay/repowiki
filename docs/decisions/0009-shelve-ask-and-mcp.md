# 0009. Shelve the Ask sidebar (F09) and the MCP server (F07, F08)

- Status: accepted
- Date: 2026-10-08
- Features: F09

## Context

The owner's goal for RepoWiki is now narrow: put their repositories into it, build each one's wiki
site, and link to those sites from a personal website. A linked site is static. The Ask sidebar
(M9, F09) needs `pnpm wiki:serve` running beside the site, with an API key and a live model call per
question, so it does nothing on a site served as plain files. The owner does not need it, and code
that stays on `main` has to be kept green, reviewed and paid for in check time.

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

## Consequences

Every page's HTML loses the 22 lines of sidebar markup; nothing else on a page changes. A built
site needs no server. The specs and plans for M9 still describe the sidebar as shipped; this ADR
is what says it is shelved. Restoring it is one merge of `ask/restore`, which also marks F09
restored here.
