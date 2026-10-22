# 0017. The example at repowiki.app/example

- Status: accepted
- Date: 2026-10-21

## Context

The home page (ADR-0016) asks a student to read an example before signing in. The owner ruled that
the example is a real page on repowiki.app, about a student with an ordinary name, Jordan Avery,
built from five of the owner's projects mirrored into the `repowiki-app` GitHub organization with
every author rewritten to "Jordan Avery". The product never shows the owner's name, and nothing on
a page is hand-edited (the owner's rulings of 2026-10-15 and 2026-10-21).

## Decision

- **What it is.** Ruling: the example is the pipeline's own output for the five mirrors: indexed,
  written, verified and linked by the engine, then built and published through the hosted flow in
  local mode on Pro. Two inputs are set by hand and nothing after them: the mirrors' authorship
  (rewritten with git-filter-repo) and the snapshot's display name, since the organization's GitHub
  name is "RepoWiki". — The page shows exactly what a student would get. — Cost if wrong: a
  rebuild, about $0.15.
- **Whose GitHub.** Ruling: the example's GitHub links go to `github.com/repowiki-app`, where the
  mirrors live; never to `github.com/jordan-avery`, which is an unrelated person's account. — A
  reader who follows a citation reaches the code it cites. — Cost if wrong: one profile field.
- **How it is served.** Ruling: the server serves `/example` from a snapshot under `example/` in the
  object store: `index.json` (the person and the projects' slugs), and per project its `entry.json`
  and its built wiki under `site/`. The biography is rendered on request by the same renderer as
  every biography, with a banner saying the student is fictional and the code real; the wikis are
  served as built, under the published wikis' CSP. Until a snapshot is stored, `/example` is not
  found. — Renderer changes reach the biography without a rebuild; the paths are reserved
  (ADR-0016), so no account can collide with them. — Cost if wrong: a route set.
- **How it is made.** Ruling: `pnpm example:snapshot` reads the local mode data directory and
  re-renders each published wiki from its stored export with the base `/example/<slug>/` and the
  author link `/example`, and `pnpm example:upload` writes the snapshot into the object store; it
  runs on the server's machine, so the storage credentials never leave Fly. — The renderer, not a
  rewrite of built HTML, moves the wikis to their new paths. — Cost if wrong: two scripts.

## Consequences

- The example goes stale like any published wiki: it shows the commit it was built from until it
  is rebuilt and uploaded again.
- The example is the one page on repowiki.app with no account behind it, and it says so.
