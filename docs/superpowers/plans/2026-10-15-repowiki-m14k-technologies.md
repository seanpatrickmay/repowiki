# M14k Libraries and Tools on the Biography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The biography shows the libraries, frameworks and tools each published project is built with, detected deterministically from the repository at the documented commit, each cited to the file that proves it and named from a curated table.

**Architecture:** `@repowiki/hosted` gains the curated table (`technologies.ts`), small parsers for dependency manifests and compose files (`manifests.ts`) and one pure detection function (`detect.ts`) over a tree's paths, some file contents and the index's external imports. `Facts` and `BiographyEntry` gain `technologies` (default `[]`). The worker runs detection inside the index child; import mode runs it over files that `pnpm hosted:profile` now saves in the snapshot. `biography()` ranks the project's technologies into the infobox, the Works table, a "Libraries and tools" table and categories; the renderer cites each to `blob/<sha>/<path>`.

**Tech Stack:** TypeScript, zod, vitest. No new dependency: the TOML subset, requirement lines, `go.mod` and compose `image:` lines are read by hand.

**Owner's rulings (2026-10-15):** recorded in ADR-0014, which this plan implements.

## Global Constraints

- `@repowiki/hosted` stays pure (core and zod only; no clock, randomness or I/O).
- Detection never fails a job: a file that will not parse contributes nothing and is logged by path.
- Tests never call the network, and none of the owner's data goes into fixtures; the six repositories were read once, during development, with `gh api`.
- Stored rows and entries without `technologies` still parse (`[]`); no migration.
- Every rendered string goes through `escapeHtml`; the templates never use a pronoun.
- Stacked branches, each near ~300 changed lines (lockfiles, fixtures and cassettes excluded; the table is data), in this order: `m14/tech-docs`, `m14/tech-table`, `m14/tech-toml`, `m14/tech-manifests`, `m14/tech-detect`, `m14/tech-facts`, `m14/tech-import`, `m14/tech-bio`, `m14/tech-render`.
- `pnpm check` passes before every commit; commits use `git -c user.email=sean.may101@gmail.com commit`.

## Review Focus

1. **The shown rule.** A library needs an importing file when its ecosystem has import data; a tool never does; nothing outside the table is shown.
2. **Fail soft.** Malformed JSON, TOML or YAML yields nothing for that file and its path in `unparsed`, never a thrown error.
3. **Bounds.** At most 100 files of 128 KB read in production, 30 of 64 KB saved locally, 60 stored.
4. **Citations.** Every technology row cites a `blob/<sha>/<path>` URL that resolves to a numbered reference with a backlink.
5. **Old data.** A generation, entry or snapshot without the field reads as no technologies.

---

### Task 1: ADR-0014, this plan and the spec note

**Files:**
- Create: `docs/decisions/0014-biography-technologies.md`, this plan
- Modify: spec 2 §8: one bullet for technologies

- [ ] **Step 1:** `git switch -c m14/tech-docs`
- [ ] **Step 2:** Write the ADR, plan and note; `pnpm check`; commit `docs(hosted): record libraries and tools on the biography (ADR-0014)`

---

### Task 2: The curated table

**Files:**
- Create: `packages/hosted/src/technologies.ts`, `packages/hosted/src/technologies.test.ts`
- Modify: `packages/hosted/src/index.ts`

**Interfaces:**
- Produces: `TECHNOLOGY_KINDS`, `TechnologyKind`, `Technology`, `TECHNOLOGIES`, `technologyById(id)`, `KIND_PRIORITY`, `isTool(t)`, `kindLabel(kind)`.

- [ ] **Step 1:** Failing tests: ids unique and kebab-case; every kind valid; no package name, alias or image claimed by two entries; no `@types/*`, linter or formatter; the owner's libraries (checked during research) are present by package name; `technologyById` finds and misses.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(hosted): add the curated table of libraries and tools`

---

### Task 3: The TOML subset

**Files:**
- Create: `packages/hosted/src/toml.ts`, `packages/hosted/src/toml.test.ts`

**Interfaces:**
- Produces: `tomlTables(text)` → `TomlTable[] | null` (each table's header path and its entries' key paths and values; inline tables keep their keys only).

- [ ] **Step 1:** Failing tests: headers, quoted and dotted keys, multi-line strings and arrays, nested values; null for each unclosed form.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(hosted): read the TOML subset that manifests use`

---

### Task 3b: Manifest parsers

**Files:**
- Create: `packages/hosted/src/manifests.ts`, `packages/hosted/src/manifests.test.ts`

**Interfaces:**
- Produces: `Declared = { ecosystem; name }`, `manifestKind(path)`, `readManifest(path, text)` → `{ declared, images } | null` (null: did not parse; compose files give images).

- [ ] **Step 1:** Failing tests per format: package.json's three sections; pyproject PEP 621, optional, dependency groups, build-system, Poetry and its groups; requirements lines with extras, markers, options, URLs and comments; Cargo's sections, target tables and `[dependencies.x]`; `go.mod` single lines and blocks; compose images; each malformed input gives null.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(hosted): read declared dependencies from manifests by hand`

---

### Task 4: Detection

**Files:**
- Create: `packages/hosted/src/detect.ts`, `packages/hosted/src/detect.test.ts`
- Modify: `packages/hosted/src/index.ts`

**Interfaces:**
- Produces: `TechnologyUse` (zod), `technologyPaths(paths)` (the paths detection reads, skipped directories removed), `sourcePaths(paths, max)` (the ones whose contents it needs, shallowest first), `importName(from, specifier)`, `detectTechnologies({ paths, sources, imports })` → `{ technologies: TechnologyUse[]; unparsed: string[] }`, `MAX_TECHNOLOGIES = 60`.

- [ ] **Step 1:** Failing tests: a declared library with an import shows with its count; declared without an import hides when the ecosystem has data, shows null when it has none; a tool shows on declaration; imported-but-undeclared shows with the first importing file; infrastructure from paths and compose images; skipped directories; evidence precedence; unparsed paths; the 60 cap and its order.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(hosted): detect a repository's libraries and tools`

---

### Task 5: Facts, the entry and the production worker

**Files:**
- Modify: `packages/hosted/src/content.ts` (`Facts.technologies`), `biography.ts` (`BiographyEntry.technologies`, `biographyEntry`), `packages/worker/src/index-child.ts`, `indexing.ts`, `facts.ts`, `run.ts`

- [ ] **Step 1:** Failing tests: old facts and entries parse with `[]`; the entry keeps only known ids; `indexInChild` passes the child's technologies through; `buildFacts` stores them; phase 2 logs unparsed paths.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(worker): detect technologies in the index child and store them in the facts`

---

### Task 6: Local import mode

**Files:**
- Modify: `packages/server/src/github/profile.ts` (`LocalProfile.repos[].technology`), `scripts/hosted-profile.ts`, `packages/worker/src/import.ts`

- [ ] **Step 1:** Failing tests: the snapshot holds the technology paths and at most 30 files of at most 64 KB at the export's head, from fake tree and contents responses; a repository with no export has none; import mode detects over them with `importingFiles: null`; an old snapshot gives `[]`.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(server): carry technology files through a local profile snapshot`

---

### Task 7: The biography's technologies

**Files:**
- Modify: `packages/hosted/src/biography.ts`, `biography.test.ts`

- [ ] **Step 1:** Failing tests: infobox top 5 by projects, importing files, name; Works top 3 by importing files then kind; the profile sentence for one and many projects; the table's top 15, kinds and per-project citations to blob URLs; categories for ≥2 projects or the top 2; unknown ids dropped; no pronoun.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(hosted): name each project's libraries and tools in the biography`

---

### Task 8: Rendering

**Files:**
- Modify: `packages/server/src/render/biography.ts`, `biography.test.ts`

- [ ] **Step 1:** Failing tests: the Technologies row after Languages; the Built with column after Main languages, "—" when empty; the sub-heading, sentence and table after the languages table; every marker resolves; everything escaped.
- [ ] **Step 2:** Implement; `pnpm check`; commit `feat(server): render libraries and tools on the biography`

---

### Task 9: Look at it

- [ ] Render a fixture account with three or more projects with technologies; screenshot at 1280 and 390 pixels with headless Chrome into the scratchpad as `m14k-shot.png` and `m14k-shot-390.png`.
