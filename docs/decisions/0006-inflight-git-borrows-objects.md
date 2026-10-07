# 0006. inflight.git borrows the documented repo's objects

- Status: accepted
- Date: 2026-10-06
- Features: F23

## Context

`pnpm wiki:inflight` fetches each open pull request's head (and, since R27, its base) into a
private bare repository, `<out>/inflight.git`, and reads it with plumbing: `merge-base`, `diff`,
`merge-tree --write-tree`, `ls-tree` and `cat-file` (spec v2 #9 R5). So that a fetch downloads
only the objects a pull request adds, inflight.git's `objects/info/alternates` names the
documented repository's object directory: every commit, tree and blob the documented repository
already has is read from there, never copied.

CLAUDE.md says RepoWiki never writes inside a repository it documents. The final M10 review found
one way the alternates touch the documented repository: when inflight.git writes an object that
already exists in the alternate (`merge-tree --write-tree` producing a tree the documented
repository has, or a fetch receiving an object it has), git's freshen step updates the
modification time of that loose object file, or of the whole pack holding it, inside
`<repo>/.git/objects`, instead of writing a second copy. No git setting turns this off. Nothing
else changes: no file's contents, no path, no ref, no config and no index entry. The only effect
is that git's prune of the documented repository counts a freshened unreachable object as recent
for longer.

The alternative is a full copy: inflight.git with its own copy of every object (a plain clone or
`git clone --no-local`). That costs disk and time in proportion to the documented repository, per
wiki, and R5 rejected it for that reason.

## Decision

inflight.git keeps borrowing the documented repository's objects through `objects/info/alternates`,
and RepoWiki accepts git's freshening of an existing object file's mtime as the one recorded
exception to "never writes inside a repo it documents". Every other guarantee stands: inflight.git
is addressed with `--git-dir`, under a ceiling directory, with no system or global config, and
nothing RepoWiki runs adds, removes or rewrites a file, ref, config entry or index entry of the
documented repository.

A test (`packages/engine/src/inflight/refresh.test.ts`, "the documented repository (ADR-0006)")
fetches pull-request heads and bases into inflight.git and derives their impacts (merge-tree
included, with one pull request whose merged tree the documented repository already holds), then
checks that the documented repository's `objects/` file list and contents, its refs, its config
and its index are byte-identical to before. It compares contents, not mtimes, because the
freshening above is expected.

## Consequences

The fetch stays small and inflight.git costs almost no disk. The documented repository's object
files can show a newer mtime after `wiki:inflight` runs, and a freshened unreachable object
survives its next `git gc --prune` for longer; no reachable data, ref or setting there changes.
If the owner rules the exception out, inflight.git must copy the objects it reads (a clone per
wiki, sized like the documented repository), and this ADR is superseded.
