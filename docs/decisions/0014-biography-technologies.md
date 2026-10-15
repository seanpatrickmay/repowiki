# 0014. Libraries and tools on the biography (F26)

- Status: accepted
- Date: 2026-10-15
- Features: F26
- Amends: ADR-0013 (Infobox, Works, Technical profile, categories); spec 2 §8

## Context

ADR-0013's biography says which languages a person's published projects are written in, and
nothing about what they are built with. A reader looking at a resume link wants to know that a
project is a FastAPI service on PostgreSQL with a React front end, not only that it is Python and
TypeScript. On 2026-10-15 the owner ruled:

1. The biography shows the libraries, frameworks and tools each project is built with.
2. Every entry is detected deterministically from the repository at the documented commit, cited
   to the file that proves it, and named from a curated table. No model, nothing hand-written.
3. Detection reads declared dependencies (every `package.json`, `pyproject.toml`,
   `requirements*.txt`, `Cargo.toml` and `go.mod`), what the indexed files actually import, and
   infrastructure files (Dockerfiles, compose service images, GitHub workflows, `fly.toml`,
   `vercel.json`, `netlify.toml`, `*.tf` and the like).
4. A technology is shown only if it is in the table and either a library imported by at least one
   indexed file, a library in a project with no import data, or a build, test or infrastructure
   tool (never imported, so its declaration or file is the evidence).
5. The infobox, the Works table and the Technical profile show them; categories gain
   "<Name> developers".

## Decision

Each ruling is "Ruling: X — why — cost if wrong".

### The table

- **A curated table in `@repowiki/hosted`.** Ruling: `technologies.ts` lists about 150 entries,
  each with an `id`, a display `name`, a `kind` (web framework, UI library, machine learning,
  data, database, testing, build tool, infrastructure, AI API, graphics, CLI, other), its package
  names per ecosystem (npm, PyPI, crates.io, Go modules; a trailing `*` matches a prefix, as in
  `@radix-ui/*`), import aliases where the import name differs from the package (`sklearn`,
  `cv2`, `PIL`, `bs4`), container image names, and path patterns for infrastructure files. The
  table was checked against the dependency manifests of the owner's six published repositories at
  their exported commits. — A table names things the way a reader knows them ("PyTorch", not
  `torch`), keeps every shown word deterministic, and lets a rename reach every page at once,
  since the biography resolves names at render time. — Cost if wrong: a library missing from the
  table is never shown until it is added; adding it is one line, but a stored generation never
  recorded it, so the project needs a refresh before it shows.
- **What is not an entry.** Ruling: languages and their compilers (`typescript`, `@types/*`),
  linters, formatters and type checkers (ESLint, Prettier, Biome, Ruff, Black, isort, mypy,
  Pylint, Flake8), git-hook tools (Husky, lint-staged) and small utilities are not entries.
  Sub-packages and plugins fold into their parent: `react-dom` is React, `@vitejs/plugin-*` is
  Vite, `pydantic-settings` is Pydantic, `pytest-*` is pytest, `tree-sitter-*` is Tree-sitter, and
  a database driver (`psycopg2`, `asyncpg`, `pg`, `better-sqlite3`) is its database. — The
  biography is about what the work is built with; a formatter says nothing about that, and the
  Languages row already names the language. — Cost if wrong: a reader misses that a project is
  linted; one table line restores an entry.
- **Tools.** Ruling: the kinds testing, build tool and infrastructure are tools, and so is an
  entry marked `tool` because it is used through a command or configuration rather than an
  import (Tailwind CSS, Uvicorn, Gunicorn). A tool is shown on its declaration or file alone. — Rule 4's third case; Tailwind and Uvicorn are almost
  never imported by a parsed file. — Cost if wrong: a declared but unused tool is shown.

### Detection

- **One pure function, run where the repository is.** Ruling: `detectTechnologies({ paths,
  sources, imports })` in `@repowiki/hosted` (`detect.ts`, with the parsers in `manifests.ts`)
  returns the shown technologies and the paths it could not parse. The worker runs it inside the
  index child, under the child's time and heap limits, over the tree's paths, the contents of its
  manifest and compose files read with the engine's `readSources`, and the index's unresolved
  external imports; import mode runs it over the local snapshot with `imports: null`. — Both modes
  share every rule; the child already holds the index and the tree. — Cost if wrong: a parser bug
  shows in both modes at once, and is fixed once.
- **Hand-written parsers, no dependency.** Ruling: `package.json` is `JSON.parse`d
  (`dependencies`, `devDependencies`, `peerDependencies`); `pyproject.toml`, `Cargo.toml` and
  `Pipfile` are read by a TOML subset (table headers, `key = value`, strings, multi-line arrays,
  inline tables read for their keys only) for PEP 621 `project.dependencies` and
  `optional-dependencies`, PEP 735 `dependency-groups`, `build-system.requires`,
  `tool.poetry.dependencies` and its dev groups (a `[tool.poetry]` table is Poetry itself), and
  Cargo's `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`,
  `[workspace.dependencies]`, `[target.*.dependencies]` and `[dependencies.<name>]`; requirement
  lines take the PEP 508 name and skip options, URLs and comments; `go.mod` reads `require` lines
  and blocks. Compose files are read for `image:` values only. A file that will not parse
  contributes nothing and its path is logged; detection never fails a job. — Each format needs a
  few dozen lines of reading, and a full TOML or YAML parser is a dependency to review for no
  benefit. — Cost if wrong: an unusual layout (a dotted key such as `dependencies.serde.version =`,
  or a YAML anchor for an image) is missed for that file.
- **Skipped directories.** Ruling: any path under `node_modules`, `vendor`, `.venv`, `dist`,
  `build` or `target` is ignored, for manifests and infrastructure files alike. — Vendored and
  built copies are not the project's own choices. — Cost if wrong: a project whose real code
  lives in a `build/` directory loses its manifests there.
- **Bounds.** Ruling: production reads at most 100 manifest and compose files, shallowest first
  and then by path, each at most 128 KB (a larger one is skipped and logged); a generation stores
  at most 60 technologies, ranked as the Works column ranks them. — A monorepo with many
  packages still fits; the stored facts stay small. — Cost if wrong: a monorepo with more than 100
  manifests loses its deepest ones.
- **Import data, per ecosystem.** Ruling: imports count for an ecosystem only when imports were
  given and the tree has a file the engine parses for it (npm: `.ts`, `.tsx`, `.mts`, `.cts`;
  PyPI: `.py`; crates: `.rs`); Go is never parsed. With no import data for its ecosystem a
  declared library is shown, with `importingFiles: null`. An import's name is the npm package root
  (`@scope/pkg`), the Python module path matched by dotted prefix (`google.cloud.aiplatform`
  matches an alias `google.cloud.aiplatform`, `numpy.linalg` matches `numpy`), or the Rust
  crate before `::`. PyPI names are compared PEP 503-normalised and crate names with `-` and `_`
  equal. — The engine does not parse JavaScript, so a JavaScript-only project would otherwise show
  no library at all. — Cost if wrong: in a TypeScript project, a library imported only from
  `.js`, `.vue` or `.svelte` files is hidden.
- **Imported but undeclared.** Ruling: a library in the table imported by an indexed file but
  declared nowhere is shown, its evidence the first importing file by path. — Script repositories
  often have no manifest; the import is the proof. — Cost if wrong: an internal module that the
  engine could not resolve and that shares a table name (say a folder called `torch`) shows as
  the library.
- **Evidence.** Ruling: a technology's evidence is its shallowest declaring manifest (then by
  path), else its first infrastructure file, else its first importing file; `importingFiles` is
  the number of distinct indexed files importing any of its names, or null when none of its
  ecosystems has import data. Compose `image:` values are matched by repository name without
  registry or tag (`postgres:16-alpine` and `docker.io/library/postgres` are `postgres`;
  `bitnami/redis` matches `bitnami/redis`, then `redis`); Dockerfile `FROM` lines are not read,
  since base images are mostly language runtimes. A `*.pyx` file is Cython; lockfiles name their
  package manager (pnpm, Yarn, Bun, Poetry, uv). — The manifest is the clearest proof for a
  reader to open. — Cost if wrong: a compose image tag that is a different product under a common
  name is mislabelled.

### Storage

- **In the facts and the entry.** Ruling: `Facts.technologies` is a list of `{ id, evidence: {
  path }, importingFiles }`, at most 60, defaulting to `[]`, so stored generations and entries
  without it still parse and no migration is needed. `BiographyEntry.technologies` (same shape,
  default `[]`) is built at preview time from the generation's facts, keeping only ids the table
  knows; the biography resolves names and kinds from the table when it renders and drops any id
  the table no longer has. — A project's words stay inside its hashed tree (ADR-0013), and a
  rename needs no data migration. — Cost if wrong: versions previewed before this change show no
  technologies until previewed and published again.

### Local import mode

- **The snapshot carries the files.** Ruling: `pnpm hosted:profile` saves, for each repository
  with a local export, the technology paths of the tree at the export's `head` (the git-tree API,
  recursive; at most 500 paths) and the contents of at most 30 of its manifest and compose files,
  at most 64 KB each, shallowest first (the contents API, raw). The import worker runs the same
  detection over them with `imports: null`, so every library in the table that is declared is
  shown and `importingFiles` is null. A snapshot taken before this change has none and gives `[]`.
  — The owner sees his real technologies locally without a clone. — Cost if wrong: locally,
  declared but unused libraries show, which production would hide; a repository with more than 30
  such files loses the deepest.

### On the biography

- **Ranking.** Ruling: across projects, technologies rank by the number of projects using them,
  then by importing files summed (null as 0), then by name; within a project, by importing files
  (null as 0), then by kind (web framework, UI library, machine learning, AI API, data, database,
  graphics, CLI, other, testing, build tool, infrastructure), then by name. — The owner's order,
  with frameworks before tools. — Cost if wrong: one comparator.
- **Infobox and Works.** Ruling: a "Technologies" row after "Languages" lists the top 5 across
  projects (no row when there are none); a "Built with" column after "Main languages" lists the
  project's top 3, or "—". — Cost if wrong: one row and one column.
- **Technical profile.** Ruling: after the languages table, an `h3` "Libraries and tools", the
  sentence "<Surname>'s projects are built most often with A, B and C." (one project:
  "<Surname>'s project is built with A, B and C."), and a wikitable Technology, Kind ("Web
  framework") and Projects, the top 15 ranked as in the infobox; each project in a row is cited to
  its evidence at `https://github.com/<owner>/<repo>/blob/<sha>/<path>` (each path segment
  URL-encoded), labelled "<Title>: <path> at commit <sha7>", one reference per distinct URL through
  the existing reference list. With no technologies the sub-section is left out. No pronoun is
  used. — Every row is checkable in one click. — Cost if wrong: the references list grows by up
  to one entry per project per row.
- **Categories.** Ruling: "<Name> developers" for the top 3 technologies used by two or more
  projects, or for the top 2 overall when none is, after the language categories. — Cost if
  wrong: one filter.

## Consequences

- A library missing from the table is invisible; the table needs a look whenever a new project
  is published with something it does not know.
- The worker's index child reads a few more blobs and prints the detected list; the facts grow by
  at most 60 small rows.
- `pnpm hosted:profile` makes one tree call and up to 30 file calls per repository with a local
  export; the runbook's local-mode section must say to take the snapshot again to see
  technologies.
- Published versions keep their old `entry.json` and show no technologies until the author
  previews and publishes again.
