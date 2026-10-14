# 0011. The hosted slice's stack: one server, a firewalled worker, Postgres through PGlite in tests (F26)

- Status: accepted
- Date: 2026-10-14
- Features: F26

## Context

ADR-0010 chose Fly.io, Neon Postgres and Cloudflare R2 for the hosted product and asked for seams
that keep a later move small. Spec 2 (the vertical slice) has to turn that into code the owner can
run before any of those accounts exist, and that the test suite can cover without the network.

## Decision

- **One server process** holds the web app, the worker's internal API and the LLM proxy. The
  sandbox boundary is between that process and the worker, not inside it.
- **One worker Machine per job attempt**, in two phases: as root it clones the public repository
  bare, then installs a firewall that allows only the server, drops root and runs the existing
  engine CLIs against the clone with the proxy as its Anthropic endpoint and a single-use job token
  as its key. A separate fetcher Machine is not built.
- **Postgres everywhere**, behind a two-method `Db` seam: `pg` in production and PGlite (Postgres
  compiled to WASM, in process) in tests, development and the demo. Three dependencies are added:
  `pg`, `@types/pg` and `@electric-sql/pglite`.
- **No AWS SDK**: the S3 store for R2 signs its few requests with SigV4 by hand, as ADR-0004 hand
  rolled JSON-RPC.
- **The proxy reserves worst cases**: a request's UTF-8 body length bounds its input tokens, so
  reserving bytes plus `max_tokens` before forwarding makes the per-job cap hard without a
  tokenizer.
- **Hosted wikis have no Wikipedia links** in this release: the firewalled worker cannot reach
  Wikipedia, and the engine already falls back to plain text.
- **Every external service has a local twin** (fake GitHub, filesystem store, child-process
  runner, fixture worker), so `pnpm hosted:demo` runs the whole journey offline.

## Consequences

- The test suite exercises real SQL, locks and constraints without a database server.
- The server needs enough memory to build a preview site with Astro (about 1 GB).
- `git clone` parses untrusted pack data before the firewall closes; that is the accepted residual
  risk of the single-Machine design.
- The owner's runbook, not this repository, carries the account and deployment steps.
