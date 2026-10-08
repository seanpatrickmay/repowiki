# 0007. Blame measures who wrote the code that exists now (F15, F17)

- Status: accepted
- Date: 2026-10-06
- Features: F15, F17
- Supersedes: 0003

## Context

ADR-0003 deferred line authorship by `git blame` to v2, to be reconsidered if a reader view
needed it. v2's People pages (spec v2 #6) need one: a person's current lines, a feature's Main
contributors and the share of current lines by person. Commit counts measure activity; only blame
measures what survived. On next-chief-of-staff a full blame of all 429 text files (69,143 lines)
takes about 27 s, and an unchanged file has an unchanged blame.

## Decision

People runs `git blame --incremental -C -C -M` once at the wiki's head over every text file, and
never per claim or per historical revision (spec v2 #6 R1). It is hermetic and read-only (C13):
`scrubbedGitEnv()`, `--literal-pathspecs`, `-c core.fsmonitor=false`, `-c
blame.markIgnoredLines=false`, `-c blame.markUnblamableLines=false`, `-c diff.algorithm=myers`,
`-c blame.ignoreRevsFile=`, `--ignore-revs-file=` (which clears the configured ignore files from
the list), `--diff-algorithm=myers`, `--indent-heuristic`, `--no-textconv`, then the sha and
`-- <path>`. git still opens every ignore file the repository's config names before it clears
the list, so a configured file git cannot read fails the blame; that failure, and any cause
`gitFailureCause` names or output past the cap, leaves the file's lines unattributed with one
warning naming the cause, and never stops People. The repository's committed
`.git-blame-ignore-revs`, read as a blob at the sha and capped at 1,000 shas, is passed as
`--ignore-rev` (R4). Results are cached in the store by `(path, blob oid)` as run-length
`[commit sha, lines]` lists, so an update blames only changed and new paths (R3). Lockfiles,
binaries and files over `DEFAULT_MAX_FILE_BYTES` are skipped; a file whose blame takes over 120 s
counts as unattributed.

The commit log People counts from (`readAuthorship`) is pinned the same way, so its counts follow
the sha and not the repository's config, replace refs or work tree: `git --no-replace-objects
--attr-source=<sha> -c core.fsmonitor=false -c core.attributesFile=/dev/null -c
core.bigFileThreshold=512m -c i18n.logOutputEncoding=UTF-8 -c diff.renames=true -c
diff.renameLimit=1000 log -z -M --root --numstat --diff-merges=off --diff-algorithm=myers
--no-show-signature --no-color --no-ext-diff --no-textconv`, then the format and the sha.
`--attr-source` needs git 2.40; with an older git (detected once) the log runs without it and
the People summary notes that attributes from the work tree may apply. The log stops after 10
minutes, or past 256 MiB of output, with a GitError.

## Consequences

ADR-0003 is superseded. The first People run on a repository costs about half a minute of blame;
later runs cost seconds. Blame follows copies and moves, so a copied file credits its original
author. Nothing outside People runs blame, so v1 commands are unchanged.
