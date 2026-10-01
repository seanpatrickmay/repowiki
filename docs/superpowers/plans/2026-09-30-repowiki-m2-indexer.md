# RepoWiki M2 (Indexer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `engine/index`, which turns a commit of any git repository into a deterministic `RepoIndex`: tree-sitter symbols for Python, TS and TSX; a resolved import graph; and git co-change. It must index next-chief-of-staff at a given sha with zero parse errors and zero unresolved internal imports.

**Architecture:** The indexer reads git objects only (`ls-tree`, `cat-file --batch`, `log`) and never the target's working tree, which keeps the spec rule that RepoWiki never writes into, or depends on the state of, a repo it documents. Parsing uses `web-tree-sitter` (WASM), with grammars from the official npm packages, so there is no native build. Each concern is a small pure module (symbols, imports, resolve, co-change), and `indexRepo` composes them. Engine modules talk only through their own `index.ts`, and a test enforces that.

**Tech Stack:** As in M1 (Node 24, pnpm 10.15.0, TypeScript 7.0.2, Biome 2.5.15, Vitest 5.0.3, zod 4.6.5), plus `web-tree-sitter 0.27.0`, `tree-sitter-python 0.25.0`, and `tree-sitter-typescript 0.23.2`.

**Spec:** `docs/superpowers/specs/2026-09-30-repowiki-v1-design.md` (§4 Architecture, the index module, the languages rule, data location; §5 membership; §8 Testing). This plan also carries out the M2 items of issue #53.

**Verification note:** before this plan was committed, all ten tasks were applied to a throwaway worktree of `main` at `c15f0b0`, exactly as written here. The results: `pnpm check` green with 242 tests (154 existing + 88 new); the tracker dry run showed 10 create, 10 link and 1 close; next-chief-of-staff at `7247d28` gave the numbers in Task 10 in under a second; and the out-of-repo refusal held. The trial surfaced three plan fixes, all folded in: the boundary regex is anchored to the start of statements, `tree-sitter-javascript` is in `ignoredBuiltDependencies`, and the engine's root exports are in Biome order.

## Global Constraints

- Node `>=24`. pnpm is pinned with `"packageManager": "pnpm@10.15.0"`.
- Dependency versions are pinned exactly, and every `pnpm add` uses `--save-exact`. New in M2: `web-tree-sitter 0.27.0`, `tree-sitter-python 0.25.0`, `tree-sitter-typescript 0.23.2`. All three are MIT-licensed and published by the tree-sitter org.
- ESM only. Relative imports use the `.ts` extension. No `enum` or `namespace`. No build step.
- Engine modules import each other only through `<module>/index.ts` (enforced from Task 3).
- Tests are co-located `*.test.ts` files and never touch the network or an LLM. Git fixtures are throwaway repos under the OS temp dir, built with `createTestRepo()` (Task 4).
- The indexer only ever runs read-only git commands against the target repo.
- Commits follow Conventional Commits with a scope. Author: `seanpatrickmay <sean.may101@gmail.com>`. Never `Co-Authored-By`, never `--no-verify`.
- `pnpm check` passes before every commit.
- One task = one branch = one PR, under ~300 changed lines (not counting `pnpm-lock.yaml`, `seed.json`, and test fixtures). Branches are named `m2/short-description`. The PR body starts with `Closes #<ticket>`.
- Merge with `gh pr merge --merge --delete-branch --author-email sean.may101@gmail.com` (merge commits only; ADR-0002).
- Biome style: 2-space indent, double quotes, semicolons, line width 100. If lint fails only on formatting, run `pnpm format`.

### Ship procedure (last step of every task)

```bash
git push -u origin HEAD
gh pr create --title "<PR title given in the task>" --body "Closes #<ticket>

<one-paragraph summary>

- [x] pnpm check passes locally"
gh pr checks --watch --fail-fast
gh pr merge --merge --delete-branch --author-email sean.may101@gmail.com
git switch main && git pull --ff-only
```

Look up ticket numbers by title (after Task 1 has seeded them):
`gh issue list --state all --search "in:title \"<ticket title>\"" --json number --jq '.[0].number'`

## Review Focus

1. **Paths with spaces, non-ASCII characters, `#`, or `%`** must be listed, read, and given member ids that round-trip. *Tests: Task 2 (memberId round-trip), Task 4 (`listBlobs` awkward names), Task 9 (`docs/C%23.md` id).*
2. **Source with syntax errors** keeps its valid symbols, sets `parseError: true`, and never throws. *Tests: Task 5, Task 9.*
3. **Binary and oversized files** are kept at file level and never fed to the parser. *Test: Task 9.*
4. **Symlinks and submodules** in the tree are skipped rather than read as files. *Test: Task 4.*
5. **A dirty or untracked working tree in the target repo** has no effect on the index (it reflects the commit), and the target repo is left untouched (`.git/index` mtime and `git status` unchanged). *Test: Task 9.*

## Spec deltas made by this plan

These are recorded in the spec in the same commit as this plan:
- **MemberId encoding (§5):** the path part percent-encodes `%` and `#`, so the first `#` always separates the path from the symbol. Symbols may themselves contain `#` (TS private members). Member ids are produced only by `memberId()` from `@repowiki/core`. This resolves #53's first M2 item.
- **Symbols (§4):** functions, classes, qualified methods, interfaces, type aliases, enums, and public module-level bindings (exported TS `const`s such as zod schemas; Python top-level assignments to non-underscore names). Bodies of functions are not descended into. Repeated names in a file (property getter and setter) merge into one span.
- **Call edges are not extracted in M2.** §7.3 diagrams want import *and* call edges. The M4 plan decides call extraction, since M4 is the first consumer.
- **Co-change:** non-merge commits only; a rename counts as delete plus add; commits touching more than 50 files are skipped and counted (configurable).

---

## File map

```
scripts/tracker/seed.json                 + M2 tickets (Task 1)
packages/core/src/member-id.ts            memberId(), parseMemberId() (Task 2)
packages/core/src/manifest.ts             MemberId schema uses parseMemberId (Task 2)
packages/engine/src/store/index.ts        store module entry (Task 3)
packages/engine/src/boundaries.test.ts    module-boundary rule (Task 3)
packages/engine/src/index/
  git.ts            resolveCommit, listBlobs, readBlobs, commitFiles  (Task 4)
  test-repo.ts      createTestRepo() fixture builder (test-only)       (Task 4)
  languages.ts      languageForPath, createSourceParser (WASM)         (Task 5)
  symbols.ts        extractSymbols                                      (Task 5)
  imports.ts        extractImports → RawImport                          (Task 6)
  resolve.ts        createResolver, parseWorkspacePackage               (Task 7)
  cochange.ts       computeCoChange                                     (Task 8)
  build-index.ts    indexRepo → RepoIndex                               (Task 9)
  index.ts          module entry                                        (Task 9)
scripts/index-repo.ts                     dev command (Task 10)
```

---

### Task 1: M2 tickets in the tracker

**Files:**
- Modify: `scripts/tracker/seed.json` (append to `issues`)

**Interfaces:**
- Produces: GitHub issues `[M2] …` that Tasks 2–10 close.

- [ ] **Step 1: Branch**

```bash
git switch -c m2/tracker-tickets
```

- [ ] **Step 2: Append these entries to the end of the `issues` array in `scripts/tracker/seed.json`**

Add a comma after the closing `}` of the current last entry (`M1-8`), then paste the following. It is already in Biome format.

```json
    {
      "key": "M2-1",
      "title": "[M2] tracker: M2 tickets",
      "labels": ["v1", "type:task", "area:infra"],
      "parent": "F19",
      "closed": true,
      "body": "**Deliverable:** M2 tickets in seed.json.\n\n**Done when:** the seed creates M2-1..M2-10. Plan: docs/superpowers/plans/2026-09-30-repowiki-m2-indexer.md Task 1."
    },
    {
      "key": "M2-2",
      "title": "[M2] core: memberId encoding",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** memberId()/parseMemberId() with %-encoding of % and # in the path part; MemberId schema uses it (issue #53).\n\n**Done when:** round-trip tests pass. Plan Task 2."
    },
    {
      "key": "M2-3",
      "title": "[M2] engine: module boundaries",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F19",
      "body": "**Deliverable:** store/index.ts and a test that engine modules import each other only through index.ts (issue #53).\n\n**Done when:** boundary test passes on the real tree. Plan Task 3."
    },
    {
      "key": "M2-4",
      "title": "[M2] index: git plumbing and fixture repos",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** read-only git access (resolveCommit, listBlobs, readBlobs, commitFiles) and createTestRepo().\n\n**Done when:** git tests pass, incl. awkward paths, symlinks, submodules. Plan Task 4."
    },
    {
      "key": "M2-5",
      "title": "[M2] index: tree-sitter symbols",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** WASM parsers for Python/TS/TSX and extractSymbols.\n\n**Done when:** symbol tests pass, incl. syntax errors. Plan Task 5."
    },
    {
      "key": "M2-6",
      "title": "[M2] index: import extraction",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** extractImports for Python and ES modules.\n\n**Done when:** import tests pass. Plan Task 6."
    },
    {
      "key": "M2-7",
      "title": "[M2] index: import resolution",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** createResolver (Python roots, relative imports, ES extensions/index/workspace packages) and parseWorkspacePackage.\n\n**Done when:** resolver tests pass. Plan Task 7."
    },
    {
      "key": "M2-8",
      "title": "[M2] index: co-change",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** computeCoChange with sweep-commit skipping.\n\n**Done when:** co-change tests pass. Plan Task 8."
    },
    {
      "key": "M2-9",
      "title": "[M2] index: indexRepo",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** indexRepo → RepoIndex, module entry, engine exports.\n\n**Done when:** end-to-end fixture tests pass, incl. determinism and untouched target repo. Plan Task 9."
    },
    {
      "key": "M2-10",
      "title": "[M2] index: dev command and next-chief-of-staff run",
      "labels": ["v1", "type:task", "area:engine"],
      "parent": "F04",
      "body": "**Deliverable:** pnpm index:repo dev command.\n\n**Done when:** next-chief-of-staff at 7247d28 indexes with 0 parse errors and 0 unresolved internal imports. Plan Task 10."
    }
```

- [ ] **Step 3: Verify, commit, ship**

Run: `pnpm check && pnpm tracker:seed --dry-run | grep -E '^(create|link|close)'`
Expected: `pnpm check` passes, and the dry run lists exactly 10 `create`, 10 `link` and 1 `close` line, all for M2 keys.

```bash
git add scripts/tracker/seed.json
git commit -m "chore(tracker): add M2 tickets"
```

Ship. PR title: `chore(tracker): add M2 tickets`. There is no `Closes` line, since the tickets don't exist yet.

- [ ] **Step 4: Seed from `main` after the merge**

```bash
pnpm tracker:seed --project 2
pnpm tracker:seed --dry-run | grep -cE '^(create|link|close)'   # expect 0
```

---

### Task 2: memberId encoding

**Ticket:** `[M2] core: memberId encoding`

**Files:**
- Create: `packages/core/src/member-id.ts`
- Modify: `packages/core/src/manifest.ts` (the `MemberId` schema), `packages/core/src/index.ts`
- Test: `packages/core/src/member-id.test.ts`, `packages/core/src/manifest.test.ts` (add cases)

**Interfaces:**
- Produces: `memberId(path: string, symbol?: string): string` and `parseMemberId(id: string): { path: string; symbol: string | null } | null`, both exported from `@repowiki/core`. `MemberId` accepts exactly the ids `memberId()` produces for valid repo paths.

- [ ] **Step 1: Branch**

```bash
git switch -c m2/member-id
```

- [ ] **Step 2: Write the failing tests**

`packages/core/src/member-id.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { memberId, parseMemberId } from "./member-id.ts";

describe("memberId", () => {
  it.each([
    ["src/a.py", undefined, "src/a.py"],
    ["src/a.py", "Thing.save", "src/a.py#Thing.save"],
    ["docs/C#.md", undefined, "docs/C%23.md"],
    ["docs/100%.md", "x", "docs/100%25.md#x"],
    ["src/a.ts", "Cls.#secret", "src/a.ts#Cls.#secret"],
  ])("encodes %j + %j as %j", (path, symbol, id) => {
    expect(memberId(path, symbol)).toBe(id);
  });

  it.each([
    ["docs/C#.md", null],
    ["docs/%23 and %25.md", "f"],
    ["src/a.ts", "Cls.#secret"],
    ["a%2523b", null],
  ])("round-trips %j + %j", (path, symbol) => {
    expect(parseMemberId(memberId(path, symbol ?? undefined))).toEqual({ path, symbol });
  });
});

describe("parseMemberId", () => {
  it.each(["src/a.py#", "docs/C%2.md", "a%zz", "100%.md"])("rejects %j", (id) => {
    expect(parseMemberId(id)).toBeNull();
  });
});
```

Add to `packages/core/src/manifest.test.ts`, next to the existing member-id `it.each` cases:
```ts
  it("accepts a member id whose path contains an encoded #", () => {
    const membership = { "docs/C%23.md": { featureId: "signals", weight: 0.5 } };
    expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(true);
  });

  it("rejects a member id with a malformed escape", () => {
    const membership = { "docs/C%2.md": { featureId: "signals", weight: 0.5 } };
    expect(Manifest.safeParse(makeManifest({ membership })).success).toBe(false);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/member-id.test.ts packages/core/src/manifest.test.ts`
Expected: FAIL, because `./member-id.ts` does not exist. The new manifest case `docs/C%2.md` is also accepted today, so that test fails too.

- [ ] **Step 4: Implement**

`packages/core/src/member-id.ts`:
```ts
/**
 * Member ids name what a feature owns: "path" for a whole file, "path#symbol" for one symbol.
 * The path part percent-encodes "%" and "#" so the first "#" always separates path from symbol;
 * symbols may contain "#" (TypeScript private members: "Cls.#secret").
 */
export function memberId(path: string, symbol?: string): string {
  const encoded = path.replace(/[%#]/g, (ch) => (ch === "%" ? "%25" : "%23"));
  return symbol === undefined ? encoded : `${encoded}#${symbol}`;
}

/** Inverse of memberId; null when the id is malformed (bad escape, empty symbol). */
export function parseMemberId(id: string): { path: string; symbol: string | null } | null {
  const hash = id.indexOf("#");
  const encoded = hash === -1 ? id : id.slice(0, hash);
  const symbol = hash === -1 ? null : id.slice(hash + 1);
  if (symbol === "" || /%(?!25|23)/.test(encoded)) return null;
  return { path: encoded.replace(/%2[53]/g, (esc) => (esc === "%25" ? "%" : "#")), symbol };
}
```

In `packages/core/src/manifest.ts`, replace the whole `MemberId` declaration with the following, and add `import { parseMemberId } from "./member-id.ts";`:
```ts
/** A memberId(): an encoded repo path, optionally "#" and a non-empty symbol. */
export const MemberId = z
  .string()
  .min(1)
  .refine((id) => {
    const parsed = parseMemberId(id);
    return parsed !== null && RepoPath.safeParse(parsed.path).success;
  }, "member id must be memberId(path) or memberId(path, symbol) for a valid repo path");
```

Add to `packages/core/src/index.ts`:
```ts
export { memberId, parseMemberId } from "./member-id.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS. The existing member-id cases (`../x.py`, `/abs.py`, `src\\a.py`, `src/a.py#`, `#fn` rejected; `src/a.py`, `src/a.py#fn`, `src/a.py#Outer#inner` accepted) are unchanged.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/core
git commit -m "feat(core): encode # and % in member id paths"
```

Ship. PR title: `feat(core): memberId encoding`.

---

### Task 3: Engine module boundaries

**Ticket:** `[M2] engine: module boundaries`

**Files:**
- Create: `packages/engine/src/store/index.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/boundaries.test.ts`

**Interfaces:**
- Produces: the rule that a file under `packages/engine/src/<module>/` may import another module only via `../<other>/index.ts`, and `src/index.ts` only via `./<module>/index.ts`. The engine's public exports are unchanged.

- [ ] **Step 1: Branch**

```bash
git switch -c m2/module-boundaries
```

- [ ] **Step 2: Write the failing test**

`packages/engine/src/boundaries.test.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The engine module a src-relative path belongs to; "" for files directly in src/. */
function moduleOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * A relative specifier in an import/export statement that starts a line. Anchoring to the line
 * start and refusing quotes before `from` keeps source text held in string fixtures from matching.
 */
const STATIC_IMPORT =
  /^(?:import|export)\s[^;"'`]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']|^import\s*["'](\.{1,2}\/[^"']+)["']/gm;

/** Relative imports that enter another module anywhere but its index.ts. */
function boundaryViolations(sources: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, source] of sources) {
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[1] ?? match[2] ?? "";
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      const to = moduleOf(target);
      if (moduleOf(path) === to || (to !== "" && target === `${to}/index.ts`)) continue;
      violations.push(`${path} imports ${specifier}`);
    }
  }
  return violations.sort();
}

/** Every .ts file under root, keyed by its root-relative POSIX path. */
function readSources(root: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const full = join(entry.parentPath, entry.name);
    sources.set(relative(root, full).split(sep).join("/"), readFileSync(full, "utf8"));
  }
  return sources;
}

describe("engine module boundaries", () => {
  it("allows same-module imports and cross-module imports through index.ts", () => {
    const sources = new Map([
      ["index/a.ts", 'import { x } from "../store/index.ts";\nimport y from "./b.ts";\n'],
      ["index.ts", 'export { a } from "./index/index.ts";\n'],
    ]);
    expect(boundaryViolations(sources)).toEqual([]);
  });

  it("flags imports of another module's internals and of the package entry", () => {
    const sources = new Map([
      ["index/a.ts", 'import type { Store } from "../store/store.ts";\n'],
      ["store/s.ts", 'import "../index.ts";\n'],
      ["index.ts", 'export { openStore } from "./store/store.ts";\n'],
    ]);
    expect(boundaryViolations(sources)).toEqual([
      "index.ts imports ./store/store.ts",
      "index/a.ts imports ../store/store.ts",
      "store/s.ts imports ../index.ts",
    ]);
  });

  it("ignores import-like text inside string literals", () => {
    const sources = new Map([
      ["index/a.test.ts", "const fixture = 'export * from \"../store/store.ts\";';\n"],
    ]);
    expect(boundaryViolations(sources)).toEqual([]);
  });

  it("holds for the engine source tree", () => {
    const sources = readSources(dirname(fileURLToPath(import.meta.url)));
    expect(boundaryViolations(sources)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run packages/engine/src/boundaries.test.ts`
Expected: the three synthetic tests PASS. "holds for the engine source tree" FAILS, listing `index.ts imports ./store/errors.ts`, `./store/export.ts`, and `./store/store.ts`.

- [ ] **Step 4: Implement**

`packages/engine/src/store/index.ts`:
```ts
export {
  DroppedFeatureError,
  DuplicateManifestError,
  EmptyStoreError,
  StaleParentError,
  StoreError,
  UnknownFeatureError,
  UnsupportedSchemaError,
} from "./errors.ts";
export { buildExport, type ExportOptions, writeExport } from "./export.ts";
export { type CitingClaim, openStore, type Store } from "./store.ts";
```

Replace `packages/engine/src/index.ts` with:
```ts
export {
  buildExport,
  type CitingClaim,
  DroppedFeatureError,
  DuplicateManifestError,
  EmptyStoreError,
  type ExportOptions,
  openStore,
  StaleParentError,
  type Store,
  StoreError,
  UnknownFeatureError,
  UnsupportedSchemaError,
  writeExport,
} from "./store/index.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS, including all existing store tests, which are unchanged.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src
git commit -m "refactor(engine): route cross-module imports through module index files"
```

Ship. PR title: `refactor(engine): module boundaries`.

---

### Task 4: Git plumbing and fixture repos

**Ticket:** `[M2] index: git plumbing and fixture repos`

**Files:**
- Create: `packages/engine/src/index/git.ts`, `packages/engine/src/index/test-repo.ts`
- Test: `packages/engine/src/index/git.test.ts`

**Interfaces:**
- Produces:
  ```ts
  class GitError extends Error
  resolveCommit(repo: string, rev: string): string            // full sha; GitError if rev names no commit
  interface TreeBlob { path: string; oid: string; size: number }
  listBlobs(repo: string, sha: string): TreeBlob[]            // regular files, sorted; no symlinks/submodules
  readBlobs(repo: string, oids: readonly string[]): Map<string, Buffer>
  commitFiles(repo: string, sha: string): string[][]          // non-merge commits, newest first
  // test-only:
  interface TestRepo { dir; git(...args): string; write(path, content: string | Buffer): void; commit(message): string; remove(): void }
  createTestRepo(): TestRepo
  ```

- [ ] **Step 1: Branch**

```bash
git switch -c m2/index-git
```

- [ ] **Step 2: Write the fixture builder (test support, no behavior of its own)**

`packages/engine/src/index/test-repo.ts`:
```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway git repository with scripted, deterministic commits. Test-only. */
export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  write(path: string, content: string | Buffer): void;
  /** Stages everything and commits; returns the new sha. Dates advance one day per commit. */
  commit(message: string): string;
  remove(): void;
}

// Isolate from the developer's git config (signing, hooks, default branch, identity).
const ISOLATED_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

export function createTestRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-index-"));
  let day = 0;
  const run = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...process.env, ...ISOLATED_ENV, ...env },
      encoding: "utf8",
    }).trim();
  run(["init", "-q", "-b", "main"]);
  return {
    dir,
    git: (...args) => run(args),
    write(path, content) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    commit(message) {
      day++;
      const date = `@${1_767_225_600 + day * 86_400} +0000`;
      run(["add", "-A"]);
      run(["commit", "-q", "--allow-empty", "-m", message], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
      return run(["rev-parse", "HEAD"]);
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 3: Write the failing tests**

`packages/engine/src/index/git.test.ts`:
```ts
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitFiles, GitError, listBlobs, readBlobs, resolveCommit } from "./git.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
});
afterEach(() => repo.remove());

describe("resolveCommit", () => {
  it("resolves HEAD, a short sha, and a branch to the full sha", () => {
    repo.write("a.py", "x = 1\n");
    const sha = repo.commit("add a");
    expect(resolveCommit(repo.dir, "HEAD")).toBe(sha);
    expect(resolveCommit(repo.dir, sha.slice(0, 7))).toBe(sha);
    expect(resolveCommit(repo.dir, "main")).toBe(sha);
  });

  it.each(["no-such-branch", "-n1", "HEAD~5"])("rejects %j with GitError", (rev) => {
    repo.write("a.py", "x = 1\n");
    repo.commit("add a");
    expect(() => resolveCommit(repo.dir, rev)).toThrow(GitError);
  });
});

describe("listBlobs", () => {
  it("lists regular files with awkward names, sorted by path", () => {
    repo.write("src/my file.py", "a = 1\n");
    repo.write("docs/C#.md", "# C#\n");
    repo.write("docs/100%.md", "done\n");
    repo.write("src/naïve.py", "b = 2\n");
    const sha = repo.commit("add files");
    expect(listBlobs(repo.dir, sha).map((blob) => blob.path)).toEqual([
      "docs/100%.md",
      "docs/C#.md",
      "src/my file.py",
      "src/naïve.py",
    ]);
  });

  it("skips symlinks and submodules", () => {
    repo.write("real.py", "x = 1\n");
    symlinkSync("real.py", join(repo.dir, "link.py"));
    const first = repo.commit("add real and link");
    repo.git("update-index", "--add", "--cacheinfo", `160000,${first},vendor/lib`);
    const sha = repo.commit("add submodule");
    expect(listBlobs(repo.dir, sha).map((blob) => blob.path)).toEqual(["real.py"]);
  });

  it("reports byte sizes", () => {
    repo.write("a.txt", "hello\n");
    const sha = repo.commit("add a");
    expect(listBlobs(repo.dir, sha)).toEqual([expect.objectContaining({ path: "a.txt", size: 6 })]);
  });
});

describe("readBlobs", () => {
  it("returns exact bytes, including binary and empty files", () => {
    const binary = Buffer.from([0x89, 0x50, 0x00, 0x0a, 0xff]);
    repo.write("img.png", binary);
    repo.write("empty.py", "");
    repo.write("a.py", "x = 1\n");
    const sha = repo.commit("add files");
    const blobs = listBlobs(repo.dir, sha);
    const contents = readBlobs(
      repo.dir,
      blobs.map((blob) => blob.oid),
    );
    const byPath = (path: string) => contents.get(blobs.find((b) => b.path === path)?.oid ?? "");
    expect(byPath("img.png")).toEqual(binary);
    expect(byPath("empty.py")).toEqual(Buffer.alloc(0));
    expect(byPath("a.py")?.toString("utf8")).toBe("x = 1\n");
  });

  it("returns an empty map for no oids", () => {
    expect(readBlobs(repo.dir, []).size).toBe(0);
  });

  it("throws GitError for an object that does not exist", () => {
    repo.write("a.py", "x = 1\n");
    repo.commit("add a");
    expect(() => readBlobs(repo.dir, ["0".repeat(40)])).toThrow(GitError);
  });
});

describe("commitFiles", () => {
  it("lists files per non-merge commit, newest first, with renames as delete + add", () => {
    repo.write("a.py", "a = 1\n");
    repo.write("b.py", "b = 1\n");
    repo.commit("add a and b");
    repo.git("checkout", "-q", "-b", "feature");
    repo.git("mv", "a.py", "renamed.py");
    repo.commit("rename a");
    repo.git("checkout", "-q", "main");
    repo.write("b.py", "b = 2\n");
    repo.commit("edit b");
    repo.git("merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    repo.commit("empty");
    const sha = repo.git("rev-parse", "HEAD");
    expect(commitFiles(repo.dir, sha)).toEqual([
      [],
      ["b.py"],
      ["a.py", "renamed.py"],
      ["a.py", "b.py"],
    ]);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/index/git.test.ts`
Expected: FAIL, because `./git.ts` does not exist.

- [ ] **Step 5: Implement**

`packages/engine/src/index/git.ts`:
```ts
import { spawnSync } from "node:child_process";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Runs a read-only git command against `repo`; never touches its working tree or index. */
function git(repo: string, args: readonly string[], input?: string): Buffer {
  const result = spawnSync("git", ["-C", repo, ...args], { input, maxBuffer: 1 << 30 });
  if (result.error) throw new GitError(`could not run git: ${result.error.message}`);
  if (result.status !== 0) {
    throw new GitError(
      `git ${args[0]} failed in ${repo}: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout;
}

/** Full 40-character sha of the commit `rev` names. */
export function resolveCommit(repo: string, rev: string): string {
  const out = spawnSync("git", [
    "-C",
    repo,
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${rev}^{commit}`,
  ]);
  const sha = out.stdout?.toString("utf8").trim() ?? "";
  if (out.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new GitError(`${repo}: "${rev}" does not name a commit`);
  }
  return sha;
}

export interface TreeBlob {
  path: string;
  oid: string;
  size: number;
}

/** Regular files at `sha`. Symlinks and submodules are skipped: they have no indexable source. */
export function listBlobs(repo: string, sha: string): TreeBlob[] {
  const out = git(repo, ["ls-tree", "-r", "-z", "--long", "--full-tree", sha]).toString("utf8");
  const blobs: TreeBlob[] = [];
  for (const entry of out.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    const [mode, type, oid, size] = entry.slice(0, tab).split(/ +/);
    if (type !== "blob" || mode === "120000" || oid === undefined || size === undefined) continue;
    blobs.push({ path: entry.slice(tab + 1), oid, size: Number(size) });
  }
  return blobs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Contents of the given blobs, keyed by object id. */
export function readBlobs(repo: string, oids: readonly string[]): Map<string, Buffer> {
  const unique = [...new Set(oids)];
  const blobs = new Map<string, Buffer>();
  if (unique.length === 0) return blobs;
  const out = git(repo, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  let offset = 0;
  while (offset < out.length) {
    const headerEnd = out.indexOf(0x0a, offset);
    const [oid, type, size] = out.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (oid === undefined || type !== "blob" || size === undefined) {
      throw new GitError(
        `unexpected cat-file header: ${out.subarray(offset, headerEnd).toString("utf8")}`,
      );
    }
    const start = headerEnd + 1;
    blobs.set(oid, out.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return blobs;
}

/** Files changed by each non-merge commit reachable from `sha`, newest first. Renames count as delete + add. */
export function commitFiles(repo: string, sha: string): string[][] {
  const out = git(repo, [
    "log",
    "--no-merges",
    "--no-renames",
    "-z",
    "--name-only",
    "--format=%x1e%H",
    sha,
  ]);
  return out
    .toString("utf8")
    .split("\x1e")
    .filter((record) => record !== "")
    .map((record) =>
      record
        .split("\0")
        .slice(1)
        .map((path) => path.replace(/^\n/, ""))
        .filter((path) => path !== ""),
    );
}
```

- [ ] **Step 6: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (11 new tests). Also confirm that `git status` in the RepoWiki checkout shows no stray files, since fixtures live under the OS temp dir and are removed in `afterEach`.

- [ ] **Step 7: Commit and ship**

```bash
git add packages/engine/src/index
git commit -m "feat(index): read commits through read-only git plumbing"
```

Ship. PR title: `feat(index): git plumbing and fixture repos`.

---

### Task 5: Tree-sitter symbols

**Ticket:** `[M2] index: tree-sitter symbols`

**Files:**
- Modify: `packages/engine/package.json` (dependencies), `pnpm-workspace.yaml`
- Create: `packages/engine/src/index/languages.ts`, `packages/engine/src/index/symbols.ts`
- Test: `packages/engine/src/index/symbols.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type SourceLanguage = "python" | "typescript" | "tsx"
  languageForPath(path: string): SourceLanguage | null
  interface ParsedSource { root: Node; hasError: boolean; dispose(): void }
  interface SourceParser { parse(language: SourceLanguage, source: string): ParsedSource }
  createSourceParser(): Promise<SourceParser>
  type SymbolKind = "function" | "class" | "method" | "variable" | "interface" | "type" | "enum"
  interface SymbolDef { qualifiedName: string; kind: SymbolKind; startLine: number; endLine: number; exported: boolean }
  extractSymbols(language: SourceLanguage, root: Node): SymbolDef[]   // sorted by startLine, then name
  ```
  (`Node` is `import type { Node } from "web-tree-sitter"`.)

- [ ] **Step 1: Branch and add the parser dependencies**

```bash
git switch -c m2/index-symbols
pnpm --filter @repowiki/engine add --save-exact web-tree-sitter@0.27.0 tree-sitter-python@0.25.0 tree-sitter-typescript@0.23.2
```

The grammar packages declare a native `install` script (`node-gyp-build`), and so does `tree-sitter-javascript`, which `tree-sitter-typescript` pulls in. RepoWiki uses only the bundled `.wasm` files, so these scripts stay blocked on purpose. Make that explicit by adding this to `pnpm-workspace.yaml`:
```yaml
ignoredBuiltDependencies:
  - tree-sitter-javascript
  - tree-sitter-python
  - tree-sitter-typescript
```

Run `pnpm install` and confirm that pnpm prints no "Ignored build scripts" warning.

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/index/symbols.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createSourceParser, type SourceLanguage, type SourceParser } from "./languages.ts";
import { extractSymbols } from "./symbols.ts";

let parser: SourceParser;
beforeAll(async () => {
  parser = await createSourceParser();
});

function symbolsOf(language: SourceLanguage, source: string) {
  const parsed = parser.parse(language, source);
  try {
    return { hasError: parsed.hasError, symbols: extractSymbols(language, parsed.root) };
  } finally {
    parsed.dispose();
  }
}

const names = (language: SourceLanguage, source: string) =>
  symbolsOf(language, source).symbols.map((s) => `${s.kind} ${s.qualifiedName}`);

describe("extractSymbols (python)", () => {
  it("finds functions, classes, and qualified methods, but not nested functions", () => {
    const source = [
      "def top():",
      "    def inner():",
      "        pass",
      "",
      "class Service:",
      "    def run(self):",
      "        pass",
      "    class Config:",
      "        def load(self): ...",
    ].join("\n");
    expect(names("python", source)).toEqual([
      "function top",
      "class Service",
      "method Service.run",
      "class Service.Config",
      "method Service.Config.load",
    ]);
  });

  it("includes decorators in the line span", () => {
    const source = "import x\n\n@app.get('/')\n@cached\ndef index():\n    return 1\n";
    expect(symbolsOf("python", source).symbols).toEqual([
      { qualifiedName: "index", kind: "function", startLine: 3, endLine: 6, exported: true },
    ]);
  });

  it("indexes public module-level bindings but not class attributes or private names", () => {
    const source = [
      "router = APIRouter()",
      "MAX_RETRIES: int = 3",
      "_cache = {}",
      "class Model:",
      "    id: int = 0",
    ].join("\n");
    expect(names("python", source)).toEqual([
      "variable router",
      "variable MAX_RETRIES",
      "class Model",
    ]);
  });

  it("marks underscore names as not exported", () => {
    const [helper] = symbolsOf("python", "def _helper():\n    pass\n").symbols;
    expect(helper?.exported).toBe(false);
  });

  it("merges a property getter and setter into one span", () => {
    const source = [
      "class K:",
      "    @property",
      "    def x(self): return 1",
      "    @x.setter",
      "    def x(self, v): pass",
    ].join("\n");
    expect(symbolsOf("python", source).symbols.find((s) => s.qualifiedName === "K.x")).toEqual({
      qualifiedName: "K.x",
      kind: "method",
      startLine: 2,
      endLine: 5,
      exported: true,
    });
  });

  it("keeps the valid definitions of a file with a syntax error", () => {
    const result = symbolsOf("python", "def ok():\n    pass\n\ndef broken(:\n    pass\n");
    expect(result.hasError).toBe(true);
    expect(result.symbols.map((s) => s.qualifiedName)).toContain("ok");
  });
});

describe("extractSymbols (typescript)", () => {
  it("finds declarations and marks exports, with the export keyword in the span", () => {
    const source = [
      "export function build() {}",
      "function local() {}",
      "export interface Options {}",
      "export type Id = string;",
      "export enum Mode { A }",
      "export const Schema = z.object({});",
      "const hidden = 1;",
      "export const run = async () => {};",
    ].join("\n");
    expect(symbolsOf("typescript", source).symbols).toEqual([
      { qualifiedName: "build", kind: "function", startLine: 1, endLine: 1, exported: true },
      { qualifiedName: "local", kind: "function", startLine: 2, endLine: 2, exported: false },
      { qualifiedName: "Options", kind: "interface", startLine: 3, endLine: 3, exported: true },
      { qualifiedName: "Id", kind: "type", startLine: 4, endLine: 4, exported: true },
      { qualifiedName: "Mode", kind: "enum", startLine: 5, endLine: 5, exported: true },
      { qualifiedName: "Schema", kind: "variable", startLine: 6, endLine: 6, exported: true },
      { qualifiedName: "run", kind: "function", startLine: 8, endLine: 8, exported: true },
    ]);
  });

  it("finds class methods, including private and abstract ones", () => {
    const source = [
      "export abstract class Store {",
      "  #secret() {}",
      "  static open() {}",
      "  abstract close(): void;",
      "}",
    ].join("\n");
    expect(names("typescript", source)).toEqual([
      "class Store",
      "method Store.#secret",
      "method Store.open",
      "method Store.close",
    ]);
  });

  it("names anonymous default exports 'default'", () => {
    expect(names("typescript", "export default function () {}")).toEqual(["function default"]);
  });

  it("finds TSX components", () => {
    const source =
      "export const Button = () => <button />;\nexport function Page() { return <main />; }\n";
    expect(names("tsx", source)).toEqual(["function Button", "function Page"]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/index/symbols.test.ts`
Expected: FAIL, because `./languages.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/index/languages.ts`:
```ts
import { createRequire } from "node:module";
import { Language, type Node, Parser } from "web-tree-sitter";

export type SourceLanguage = "python" | "typescript" | "tsx";

const GRAMMARS: Record<SourceLanguage, string> = {
  python: "tree-sitter-python/tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
};

/** The grammar used for a path, or null for files indexed at file level only. */
export function languageForPath(path: string): SourceLanguage | null {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".tsx")) return "tsx";
  if (/\.[cm]?ts$/.test(path)) return "typescript";
  return null;
}

export interface ParsedSource {
  root: Node;
  hasError: boolean;
  /** Frees the WASM-side tree. Call once the root is no longer needed. */
  dispose(): void;
}

export interface SourceParser {
  parse(language: SourceLanguage, source: string): ParsedSource;
}

const require = createRequire(import.meta.url);
let languages: Promise<Map<SourceLanguage, Language>> | undefined;

async function loadLanguages(): Promise<Map<SourceLanguage, Language>> {
  await Parser.init();
  const ids = Object.keys(GRAMMARS) as SourceLanguage[];
  const loaded = await Promise.all(ids.map((id) => Language.load(require.resolve(GRAMMARS[id]))));
  return new Map(ids.map((id, i) => [id, loaded[i] as Language]));
}

export async function createSourceParser(): Promise<SourceParser> {
  languages ??= loadLanguages();
  const grammars = await languages;
  const parser = new Parser();
  return {
    parse(language, source) {
      parser.setLanguage(grammars.get(language) ?? null);
      const tree = parser.parse(source);
      if (tree === null) throw new Error(`tree-sitter produced no tree for ${language} source`);
      return {
        root: tree.rootNode,
        hasError: tree.rootNode.hasError,
        dispose: () => tree.delete(),
      };
    },
  };
}
```

`packages/engine/src/index/symbols.ts`:
```ts
import type { Node } from "web-tree-sitter";
import type { SourceLanguage } from "./languages.ts";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "variable"
  | "interface"
  | "type"
  | "enum";

export interface SymbolDef {
  /** Dotted path inside the file: "K.m" for a method m of class K. */
  qualifiedName: string;
  kind: SymbolKind;
  /** 1-based inclusive line span, including decorators and an `export` keyword. */
  startLine: number;
  endLine: number;
  exported: boolean;
}

function symbol(qualifiedName: string, kind: SymbolKind, span: Node, exported: boolean): SymbolDef {
  return {
    qualifiedName,
    kind,
    startLine: span.startPosition.row + 1,
    endLine: span.endPosition.row + 1,
    exported,
  };
}

/** Top-level definitions plus class members; bodies of functions are not descended into. */
export function extractSymbols(language: SourceLanguage, root: Node): SymbolDef[] {
  const out: SymbolDef[] = [];
  if (language === "python") collectPython(root, null, out);
  else collectTypeScript(root, out);
  return mergeDuplicates(out).sort(
    (a, b) => a.startLine - b.startLine || a.qualifiedName.localeCompare(b.qualifiedName),
  );
}

/** One symbol per name: a getter/setter pair or a conditional redefinition becomes one span. */
function mergeDuplicates(symbols: SymbolDef[]): SymbolDef[] {
  const byName = new Map<string, SymbolDef>();
  for (const next of symbols) {
    const seen = byName.get(next.qualifiedName);
    if (seen === undefined) {
      byName.set(next.qualifiedName, { ...next });
      continue;
    }
    seen.startLine = Math.min(seen.startLine, next.startLine);
    seen.endLine = Math.max(seen.endLine, next.endLine);
    seen.exported ||= next.exported;
  }
  return [...byName.values()];
}

function collectPython(container: Node, owner: string | null, out: SymbolDef[]): void {
  for (const child of container.namedChildren) {
    if (child.type === "expression_statement") {
      // Module-level public bindings: `router = APIRouter()`, `MAX_RETRIES = 3`.
      if (owner !== null) continue;
      for (const assignment of child.namedChildren) {
        const target =
          assignment.type === "assignment" ? assignment.childForFieldName("left") : null;
        if (target?.type === "identifier" && !target.text.startsWith("_")) {
          out.push(symbol(target.text, "variable", child, true));
        }
      }
      continue;
    }
    const definition =
      child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
    const name = definition?.childForFieldName("name")?.text;
    if (!definition || !name) continue;
    const qualifiedName = owner === null ? name : `${owner}.${name}`;
    const exported = !name.startsWith("_");
    if (definition.type === "function_definition") {
      out.push(symbol(qualifiedName, owner === null ? "function" : "method", child, exported));
    } else if (definition.type === "class_definition") {
      out.push(symbol(qualifiedName, "class", child, exported));
      const body = definition.childForFieldName("body");
      if (body) collectPython(body, qualifiedName, out);
    }
  }
}

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "generator_function"]);

function collectTypeScript(root: Node, out: SymbolDef[]): void {
  for (const child of root.namedChildren) {
    if (child.type !== "export_statement") {
      collectDeclaration(child, child, false, out);
      continue;
    }
    const declaration = child.childForFieldName("declaration");
    if (declaration) {
      collectDeclaration(declaration, child, true, out);
      continue;
    }
    const value = child.childForFieldName("value");
    if (value && FUNCTION_VALUES.has(value.type))
      out.push(symbol("default", "function", child, true));
    else if (value?.type === "class") out.push(symbol("default", "class", child, true));
  }
}

function collectDeclaration(
  declaration: Node,
  span: Node,
  exported: boolean,
  out: SymbolDef[],
): void {
  const name = declaration.childForFieldName("name")?.text;
  switch (declaration.type) {
    case "function_declaration":
    case "generator_function_declaration":
      if (name) out.push(symbol(name, "function", span, exported));
      return;
    case "class_declaration":
    case "abstract_class_declaration": {
      if (!name) return;
      out.push(symbol(name, "class", span, exported));
      const body = declaration.childForFieldName("body");
      for (const member of body ? body.namedChildren : []) {
        if (member.type !== "method_definition" && member.type !== "abstract_method_signature")
          continue;
        const method = member.childForFieldName("name")?.text;
        if (method) out.push(symbol(`${name}.${method}`, "method", member, exported));
      }
      return;
    }
    case "interface_declaration":
      if (name) out.push(symbol(name, "interface", span, exported));
      return;
    case "type_alias_declaration":
      if (name) out.push(symbol(name, "type", span, exported));
      return;
    case "enum_declaration":
      if (name) out.push(symbol(name, "enum", span, exported));
      return;
    case "lexical_declaration":
    case "variable_declaration":
      for (const declarator of declaration.namedChildren) {
        if (declarator.type !== "variable_declarator") continue;
        const id = declarator.childForFieldName("name");
        const value = declarator.childForFieldName("value");
        if (id?.type !== "identifier") continue;
        if (value && FUNCTION_VALUES.has(value.type))
          out.push(symbol(id.text, "function", span, exported));
        else if (exported) out.push(symbol(id.text, "variable", span, true));
      }
      return;
  }
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (10 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(index): extract symbols with tree-sitter WASM grammars"
```

Ship. PR title: `feat(index): tree-sitter symbols`.

---

### Task 6: Import extraction

**Ticket:** `[M2] index: import extraction`

**Files:**
- Create: `packages/engine/src/index/imports.ts`
- Test: `packages/engine/src/index/imports.test.ts`

**Interfaces:**
- Consumes: `createSourceParser`, `SourceLanguage` (Task 5).
- Produces:
  ```ts
  type RawImport =
    | { kind: "python"; module: string; level: number; names: string[]; line: number }
    | { kind: "es"; specifier: string; line: number }
  extractImports(language: SourceLanguage, root: Node): RawImport[]   // document order
  ```

- [ ] **Step 1: Branch**

```bash
git switch -c m2/index-imports
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/index/imports.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { extractImports } from "./imports.ts";
import { createSourceParser, type SourceLanguage, type SourceParser } from "./languages.ts";

let parser: SourceParser;
beforeAll(async () => {
  parser = await createSourceParser();
});

function importsOf(language: SourceLanguage, source: string) {
  const parsed = parser.parse(language, source);
  try {
    return extractImports(language, parsed.root);
  } finally {
    parsed.dispose();
  }
}

describe("extractImports (python)", () => {
  it("reads plain, aliased, and multi-module imports", () => {
    expect(importsOf("python", "import os, a.b as c\n")).toEqual([
      { kind: "python", module: "os", level: 0, names: [], line: 1 },
      { kind: "python", module: "a.b", level: 0, names: [], line: 1 },
    ]);
  });

  it("reads relative from-imports with their level and names", () => {
    expect(importsOf("python", "from ..a.b import c as d, e\nfrom . import f\n")).toEqual([
      { kind: "python", module: "a.b", level: 2, names: ["c", "e"], line: 1 },
      { kind: "python", module: "", level: 1, names: ["f"], line: 2 },
    ]);
  });

  it("treats a wildcard import as importing the module itself", () => {
    expect(importsOf("python", "from pkg.mod import *\n")).toEqual([
      { kind: "python", module: "pkg.mod", level: 0, names: [], line: 1 },
    ]);
  });

  it("finds imports nested in functions and try blocks", () => {
    const source =
      "def f():\n    import json\ntry:\n    from x import y\nexcept ImportError:\n    pass\n";
    expect(importsOf("python", source).map((i) => i.line)).toEqual([2, 4]);
  });

  it("ignores __future__ imports", () => {
    expect(importsOf("python", "from __future__ import annotations\n")).toEqual([]);
  });
});

describe("extractImports (typescript)", () => {
  it("reads static imports, re-exports, and dynamic imports", () => {
    const source = [
      'import React from "react";',
      'import type { A } from "./a.js";',
      'import "./styles.css";',
      'export * from "../b";',
      'export { c } from "@scope/pkg/sub";',
      'const Page = lazy(() => import("./Page"));',
      "export const x = 1;",
      'const y = require("ignored");',
    ].join("\n");
    expect(importsOf("tsx", source)).toEqual([
      { kind: "es", specifier: "react", line: 1 },
      { kind: "es", specifier: "./a.js", line: 2 },
      { kind: "es", specifier: "./styles.css", line: 3 },
      { kind: "es", specifier: "../b", line: 4 },
      { kind: "es", specifier: "@scope/pkg/sub", line: 5 },
      { kind: "es", specifier: "./Page", line: 6 },
    ]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/index/imports.test.ts`
Expected: FAIL, because `./imports.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/index/imports.ts`:
```ts
import type { Node } from "web-tree-sitter";
import type { SourceLanguage } from "./languages.ts";

/** An import as written in the source, before resolution to a file. */
export type RawImport =
  | { kind: "python"; module: string; level: number; names: string[]; line: number }
  | { kind: "es"; specifier: string; line: number };

export function extractImports(language: SourceLanguage, root: Node): RawImport[] {
  return language === "python" ? pythonImports(root) : esImports(root);
}

function dottedText(node: Node): string | null {
  if (node.type === "dotted_name") return node.text;
  if (node.type === "aliased_import") return node.childForFieldName("name")?.text ?? null;
  return null;
}

function pythonImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  for (const node of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    const line = node.startPosition.row + 1;
    const names = node
      .childrenForFieldName("name")
      .map(dottedText)
      .filter((name): name is string => name !== null);
    if (node.type === "import_statement") {
      for (const module of names) out.push({ kind: "python", module, level: 0, names: [], line });
      continue;
    }
    const moduleNode = node.childForFieldName("module_name");
    if (moduleNode === null) continue;
    if (moduleNode.type === "relative_import") {
      const prefix = moduleNode.namedChildren.find((n) => n.type === "import_prefix")?.text ?? "";
      const dotted = moduleNode.namedChildren.find((n) => n.type === "dotted_name")?.text ?? "";
      out.push({ kind: "python", module: dotted, level: prefix.length, names, line });
    } else {
      out.push({ kind: "python", module: moduleNode.text, level: 0, names, line });
    }
  }
  return out;
}

function stringValue(node: Node | null): string | null {
  if (node?.type !== "string") return null;
  return node.namedChildren.find((n) => n.type === "string_fragment")?.text ?? "";
}

function esImports(root: Node): RawImport[] {
  const out: RawImport[] = [];
  for (const node of root.descendantsOfType([
    "import_statement",
    "export_statement",
    "call_expression",
  ])) {
    let specifier: string | null = null;
    if (node.type === "call_expression") {
      if (node.childForFieldName("function")?.type !== "import") continue;
      const args = node.childForFieldName("arguments");
      specifier = stringValue(args?.namedChildren[0] ?? null);
    } else {
      specifier = stringValue(node.childForFieldName("source"));
    }
    if (specifier) out.push({ kind: "es", specifier, line: node.startPosition.row + 1 });
  }
  return out;
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (6 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src/index
git commit -m "feat(index): extract Python and ES module imports"
```

Ship. PR title: `feat(index): import extraction`.

---

### Task 7: Import resolution

**Ticket:** `[M2] index: import resolution`

**Files:**
- Create: `packages/engine/src/index/resolve.ts`
- Test: `packages/engine/src/index/resolve.test.ts`

**Interfaces:**
- Consumes: `RawImport` (Task 6).
- Produces:
  ```ts
  interface WorkspacePackage { name: string; exports: Record<string, string> }   // subpath → repo file
  interface ImportResolution { targets: string[]; external: boolean }
  interface Resolver { resolve(fromPath: string, raw: RawImport): ImportResolution }
  createResolver(paths: readonly string[], packages: readonly WorkspacePackage[]): Resolver
  parseWorkspacePackage(packageJsonPath: string, text: string): WorkspacePackage | null
  ```
- Rules:
  - A Python source root is the parent of every top-level package (a directory with `__init__.py` whose parent has none), plus the repo root. That covers both `src/` layouts and flat layouts.
  - `from M import n` resolves to the submodule `M.n` when one exists, otherwise to `M` itself.
  - ES specifiers try the exact file, then a `.js`→`.ts` swap, then the listed extensions, then `/index.*`.
  - Bare specifiers resolve through workspace packages' `exports` (or `main`) and are otherwise external.

- [ ] **Step 1: Branch**

```bash
git switch -c m2/index-resolve
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/index/resolve.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { RawImport } from "./imports.ts";
import { createResolver, parseWorkspacePackage } from "./resolve.ts";

const FILES = [
  "src/pkg/__init__.py",
  "src/pkg/a.py",
  "src/pkg/sub/__init__.py",
  "src/pkg/sub/b.py",
  "tests/test_a.py",
  "tools/run.py",
  "web/src/main.tsx",
  "web/src/lib/index.ts",
  "web/src/lib/util.ts",
  "web/src/components/Button.tsx",
  "web/src/data.json",
  "packages/core/src/index.ts",
];
const CORE = { name: "@x/core", exports: { ".": "packages/core/src/index.ts" } };
const resolver = createResolver(FILES, [CORE]);

const py = (module: string, names: string[] = [], level = 0): RawImport => ({
  kind: "python",
  module,
  level,
  names,
  line: 1,
});
const es = (specifier: string): RawImport => ({ kind: "es", specifier, line: 1 });

describe("python resolution", () => {
  it.each([
    ["absolute import through a src/ root", "tests/test_a.py", py("pkg.a"), ["src/pkg/a.py"]],
    ["package import to __init__.py", "tests/test_a.py", py("pkg"), ["src/pkg/__init__.py"]],
    ["from-import of a submodule", "tests/test_a.py", py("pkg", ["a"]), ["src/pkg/a.py"]],
    [
      "from-import of a name in __init__",
      "tests/test_a.py",
      py("pkg", ["VERSION"]),
      ["src/pkg/__init__.py"],
    ],
    [
      "from-import mixing a submodule and a name",
      "tests/test_a.py",
      py("pkg.sub", ["b", "helper"]),
      ["src/pkg/sub/__init__.py", "src/pkg/sub/b.py"],
    ],
    ["relative import two levels up", "src/pkg/sub/b.py", py("", ["a"], 2), ["src/pkg/a.py"]],
    [
      "relative import of the own package",
      "src/pkg/sub/b.py",
      py("", ["missing"], 1),
      ["src/pkg/sub/__init__.py"],
    ],
  ])("%s", (_name, from, raw, targets) => {
    expect(resolver.resolve(from, raw)).toEqual({ targets, external: false });
  });

  it("marks unknown absolute imports as external", () => {
    expect(resolver.resolve("src/pkg/a.py", py("os"))).toEqual({ targets: [], external: true });
  });

  it("marks unresolvable relative imports as internal misses", () => {
    expect(resolver.resolve("src/pkg/a.py", py("nope", [], 1))).toEqual({
      targets: [],
      external: false,
    });
  });

  it("refuses relative imports that climb above the repo root", () => {
    expect(resolver.resolve("tools/run.py", py("x", [], 3))).toEqual({
      targets: [],
      external: false,
    });
  });
});

describe("es resolution", () => {
  it.each([
    ["extensionless file", "./lib/util", ["web/src/lib/util.ts"]],
    ["directory index", "./lib", ["web/src/lib/index.ts"]],
    [
      "ESM .js specifier for a .tsx source",
      "./components/Button.js",
      ["web/src/components/Button.tsx"],
    ],
    ["exact file with extension", "./data.json", ["web/src/data.json"]],
    ["workspace package root export", "@x/core", ["packages/core/src/index.ts"]],
  ])("%s", (_name, specifier, targets) => {
    expect(resolver.resolve("web/src/main.tsx", es(specifier))).toEqual({
      targets,
      external: false,
    });
  });

  it("marks npm packages as external", () => {
    expect(resolver.resolve("web/src/main.tsx", es("react-dom/client"))).toEqual({
      targets: [],
      external: true,
    });
  });

  it.each([
    ["missing relative file", "./nope"],
    ["path escaping the repo", "../../../outside"],
    ["absolute path", "/etc/passwd"],
    ["unexported workspace subpath", "@x/core/internal"],
  ])("leaves a %s unresolved and internal", (_name, specifier) => {
    expect(resolver.resolve("web/src/main.tsx", es(specifier))).toEqual({
      targets: [],
      external: false,
    });
  });
});

describe("parseWorkspacePackage", () => {
  it.each([
    ["string exports", { name: "a", exports: "./src/index.ts" }, { ".": "pkgs/a/src/index.ts" }],
    [
      "conditional root exports",
      { name: "a", exports: { import: "./esm.js", require: "./cjs.js" } },
      { ".": "pkgs/a/esm.js" },
    ],
    [
      "subpath exports with conditions",
      { name: "a", exports: { ".": "./i.ts", "./x": { default: "./x.ts" } } },
      { ".": "pkgs/a/i.ts", "./x": "pkgs/a/x.ts" },
    ],
    ["main fallback", { name: "a", main: "lib/main.js" }, { ".": "pkgs/a/lib/main.js" }],
    ["no entry points", { name: "a" }, {}],
  ])("reads %s", (_name, json, exports) => {
    expect(parseWorkspacePackage("pkgs/a/package.json", JSON.stringify(json))).toEqual({
      name: "a",
      exports,
    });
  });

  it("resolves a root package.json relative to the repo root", () => {
    expect(parseWorkspacePackage("package.json", '{"name":"root","main":"index.ts"}')).toEqual({
      name: "root",
      exports: { ".": "index.ts" },
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["no name", "{}"],
    ["a non-object", "[]"],
  ])("returns null for %s", (_name, text) => {
    expect(parseWorkspacePackage("package.json", text)).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/index/resolve.test.ts`
Expected: FAIL, because `./resolve.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/index/resolve.ts`:
```ts
import { posix } from "node:path";
import type { RawImport } from "./imports.ts";

export interface WorkspacePackage {
  name: string;
  /** Subpath ("." or "./x") → repo-relative target file. */
  exports: Record<string, string>;
}

export interface ImportResolution {
  /** Repo files the import loads; empty when unresolved. */
  targets: string[];
  /** True when the import names something outside the repo (stdlib, npm, PyPI). */
  external: boolean;
}

export interface Resolver {
  resolve(fromPath: string, raw: RawImport): ImportResolution;
}

/** Repo-relative join; "" is the repo root. */
function joinRepo(...parts: string[]): string {
  const joined = posix.normalize(parts.filter((p) => p !== "").join("/"));
  return joined === "." ? "" : joined;
}

function parentDir(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const conditions = value as Record<string, unknown>;
    for (const key of ["import", "default", "types"]) {
      if (typeof conditions[key] === "string") return conditions[key] as string;
    }
  }
  return null;
}

function exportMap(pkg: Record<string, unknown>): Record<string, unknown> {
  const { exports, main } = pkg;
  if (typeof exports === "string") return { ".": exports };
  if (exports !== null && typeof exports === "object") {
    const map = exports as Record<string, unknown>;
    // An object without "." keys is a set of conditions for the root export.
    return Object.keys(map).some((key) => key.startsWith(".")) ? map : { ".": map };
  }
  return typeof main === "string" ? { ".": main } : {};
}

/** Reads a tracked package.json; returns null if it is not a named package. */
export function parseWorkspacePackage(
  packageJsonPath: string,
  text: string,
): WorkspacePackage | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object") return null;
  const pkg = json as Record<string, unknown>;
  if (typeof pkg.name !== "string") return null;
  const dir = parentDir(packageJsonPath);
  const exports: Record<string, string> = {};
  for (const [subpath, value] of Object.entries(exportMap(pkg))) {
    const target = exportTarget(value);
    if (target !== null && subpath.startsWith(".")) exports[subpath] = joinRepo(dir, target);
  }
  return { name: pkg.name, exports };
}

const ES_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

export function createResolver(
  paths: readonly string[],
  packages: readonly WorkspacePackage[],
): Resolver {
  const files = new Set(paths);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));

  // A Python source root is the parent of a top-level package (a dir with __init__.py whose parent has none).
  const pythonRoots = new Set<string>([""]);
  for (const path of files) {
    if (posix.basename(path) !== "__init__.py") continue;
    const parent = parentDir(parentDir(path));
    if (!files.has(joinRepo(parent, "__init__.py"))) pythonRoots.add(parent);
  }
  const roots = [...pythonRoots].sort();

  const pythonModule = (base: string, dotted: string): string | null => {
    const asPath = dotted
      .split(".")
      .filter((s) => s !== "")
      .join("/");
    for (const candidate of asPath === ""
      ? [joinRepo(base, "__init__.py")]
      : [joinRepo(base, `${asPath}.py`), joinRepo(base, asPath, "__init__.py")]) {
      if (files.has(candidate)) return candidate;
    }
    return null;
  };

  const resolvePython = (
    fromPath: string,
    raw: Extract<RawImport, { kind: "python" }>,
  ): ImportResolution => {
    let bases = roots;
    if (raw.level > 0) {
      let base = parentDir(fromPath);
      for (let i = 1; i < raw.level; i++) {
        if (base === "") return { targets: [], external: false };
        base = parentDir(base);
      }
      bases = [base];
    }
    const find = (dotted: string): string | null => {
      for (const base of bases) {
        const hit = pythonModule(base, dotted);
        if (hit !== null) return hit;
      }
      return null;
    };
    const targets = new Set<string>();
    let needsModule = raw.names.length === 0;
    for (const name of raw.names) {
      const submodule = find(raw.module === "" ? name : `${raw.module}.${name}`);
      if (submodule !== null) targets.add(submodule);
      else needsModule = true;
    }
    if (needsModule) {
      const module = find(raw.module);
      if (module !== null) targets.add(module);
    }
    return { targets: [...targets].sort(), external: raw.level === 0 && targets.size === 0 };
  };

  const resolveFile = (candidate: string): string | null => {
    if (candidate !== "") {
      if (files.has(candidate)) return candidate;
      // TypeScript ESM source imports "./a.js" for the file a.ts.
      if (/\.[cm]?jsx?$/.test(candidate)) {
        for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
          const swapped = candidate.replace(/\.[cm]?jsx?$/, ext);
          if (files.has(swapped)) return swapped;
        }
      }
      for (const ext of ES_EXTENSIONS) {
        if (files.has(`${candidate}${ext}`)) return `${candidate}${ext}`;
      }
    }
    const dir = candidate === "" ? "" : `${candidate}/`;
    for (const ext of ES_EXTENSIONS) {
      if (files.has(`${dir}index${ext}`)) return `${dir}index${ext}`;
    }
    return null;
  };

  const resolveEs = (fromPath: string, specifier: string): ImportResolution => {
    if (
      specifier === "." ||
      specifier === ".." ||
      specifier.startsWith("./") ||
      specifier.startsWith("../")
    ) {
      const joined = posix.normalize(posix.join(parentDir(fromPath) || ".", specifier));
      if (joined === ".." || joined.startsWith("../")) return { targets: [], external: false };
      const hit = resolveFile(joined === "." ? "" : joined);
      return { targets: hit === null ? [] : [hit], external: false };
    }
    if (specifier.startsWith("/")) return { targets: [], external: false };
    const segments = specifier.split("/");
    const nameLength = specifier.startsWith("@") ? 2 : 1;
    const pkg = byName.get(segments.slice(0, nameLength).join("/"));
    if (pkg === undefined) return { targets: [], external: true };
    const rest = segments.slice(nameLength).join("/");
    const target = pkg.exports[rest === "" ? "." : `./${rest}`];
    const hit = target === undefined ? null : resolveFile(target);
    return { targets: hit === null ? [] : [hit], external: false };
  };

  return {
    resolve: (fromPath, raw) =>
      raw.kind === "python" ? resolvePython(fromPath, raw) : resolveEs(fromPath, raw.specifier),
  };
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (29 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src/index
git commit -m "feat(index): resolve imports to repo files"
```

Ship. PR title: `feat(index): import resolution`.

---

### Task 8: Co-change

**Ticket:** `[M2] index: co-change`

**Files:**
- Create: `packages/engine/src/index/cochange.ts`
- Test: `packages/engine/src/index/cochange.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface CoChangePair { a: string; b: string; count: number }   // a < b
  interface CoChange { commitsConsidered: number; commitsSkipped: number; fileCommits: Record<string, number>; pairs: CoChangePair[] }
  const DEFAULT_MAX_FILES_PER_COMMIT = 50
  computeCoChange(commits: readonly (readonly string[])[], present: ReadonlySet<string>, maxFilesPerCommit?: number): CoChange
  ```
  The output holds raw counts only. Normalizing them (Jaccard or similar) is clustering's job in M3.

- [ ] **Step 1: Branch**

```bash
git switch -c m2/index-cochange
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/index/cochange.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeCoChange } from "./cochange.ts";

const present = new Set(["a.py", "b.py", "c.py"]);

describe("computeCoChange", () => {
  it("counts files changed together, as sorted unordered pairs", () => {
    const result = computeCoChange([["b.py", "a.py"], ["a.py", "b.py", "c.py"], ["c.py"]], present);
    expect(result.pairs).toEqual([
      { a: "a.py", b: "b.py", count: 2 },
      { a: "a.py", b: "c.py", count: 1 },
      { a: "b.py", b: "c.py", count: 1 },
    ]);
    expect(result.fileCommits).toEqual({ "a.py": 2, "b.py": 2, "c.py": 2 });
    expect(result.commitsConsidered).toBe(3);
  });

  it("ignores files that no longer exist at the indexed commit", () => {
    const result = computeCoChange([["a.py", "deleted.py"]], present);
    expect(result.pairs).toEqual([]);
    expect(result.fileCommits).toEqual({ "a.py": 1 });
  });

  it("skips commits that touch more files than the limit", () => {
    const sweep = ["a.py", "b.py", "c.py"];
    const result = computeCoChange([sweep, ["a.py", "b.py"]], present, 2);
    expect(result.commitsSkipped).toBe(1);
    expect(result.commitsConsidered).toBe(1);
    expect(result.pairs).toEqual([{ a: "a.py", b: "b.py", count: 1 }]);
  });

  it("counts a file listed twice in one commit once", () => {
    const result = computeCoChange([["a.py", "a.py", "b.py"]], present);
    expect(result.fileCommits).toEqual({ "a.py": 1, "b.py": 1 });
    expect(result.pairs).toEqual([{ a: "a.py", b: "b.py", count: 1 }]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/index/cochange.test.ts`
Expected: FAIL, because `./cochange.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/index/cochange.ts`:
```ts
export interface CoChangePair {
  a: string;
  b: string;
  count: number;
}

export interface CoChange {
  /** Commits that contributed pairs. */
  commitsConsidered: number;
  /** Commits ignored for touching more than maxFilesPerCommit files (formatting sweeps, lockfile bumps). */
  commitsSkipped: number;
  /** Per file present at the indexed sha: how many considered commits touched it. */
  fileCommits: Record<string, number>;
  /** Unordered pairs (a < b) of present files changed together, with how often. */
  pairs: CoChangePair[];
}

export const DEFAULT_MAX_FILES_PER_COMMIT = 50;

export function computeCoChange(
  commits: readonly (readonly string[])[],
  present: ReadonlySet<string>,
  maxFilesPerCommit = DEFAULT_MAX_FILES_PER_COMMIT,
): CoChange {
  const fileCommits = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  let considered = 0;
  let skipped = 0;
  for (const changed of commits) {
    const unique = [...new Set(changed)];
    if (unique.length > maxFilesPerCommit) {
      skipped++;
      continue;
    }
    considered++;
    const files = unique.filter((path) => present.has(path)).sort();
    for (const file of files) fileCommits.set(file, (fileCommits.get(file) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\0${files[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs = [...pairCounts]
    .map(([key, count]) => {
      const [a = "", b = ""] = key.split("\0");
      return { a, b, count };
    })
    .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return {
    commitsConsidered: considered,
    commitsSkipped: skipped,
    fileCommits: Object.fromEntries([...fileCommits].sort(([x], [y]) => (x < y ? -1 : 1))),
    pairs,
  };
}
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (4 new tests).

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src/index
git commit -m "feat(index): count file co-change from history"
```

Ship. PR title: `feat(index): co-change`.

---

### Task 9: indexRepo

**Ticket:** `[M2] index: indexRepo`

**Files:**
- Create: `packages/engine/src/index/build-index.ts`, `packages/engine/src/index/index.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/index/build-index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–8, and `memberId` from `@repowiki/core` (Task 2).
- Produces:
  ```ts
  interface IndexedSymbol extends SymbolDef { id: string }
  interface IndexedFile { id; path; language: SourceLanguage | null; bytes; loc; skipped: "binary" | "too-large" | null; parseError: boolean; symbols: IndexedSymbol[] }
  interface ImportEdge { from: string; to: string; line: number }
  interface UnresolvedImport { from: string; specifier: string; line: number; external: boolean }
  interface RepoIndex { sha: string; files: IndexedFile[]; imports: ImportEdge[]; unresolved: UnresolvedImport[]; coChange: CoChange }
  interface IndexOptions { maxFileBytes?: number; maxFilesPerCommit?: number }
  const DEFAULT_MAX_FILE_BYTES = 1_000_000
  indexRepo(repo: string, rev: string, options?: IndexOptions): Promise<RepoIndex>
  ```
  `RepoIndex` is deterministic: two runs on the same sha produce deep-equal results.

- [ ] **Step 1: Branch**

```bash
git switch -c m2/index-repo
```

- [ ] **Step 2: Write the failing tests**

`packages/engine/src/index/build-index.test.ts`:
```ts
import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepo } from "./build-index.ts";
import { GitError } from "./git.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
let sha: string;

beforeEach(() => {
  repo = createTestRepo();
  repo.write("src/app/__init__.py", "");
  repo.write("src/app/models.py", "class Thing:\n    def save(self):\n        pass\n");
  repo.write("web/b.ts", "export const b = 1;\n");
  repo.commit("models and b");
  repo.write(
    "src/app/api.py",
    "import os\nfrom .models import Thing\nfrom .models import Thing as T\n",
  );
  repo.write("src/app/models.py", "class Thing:\n    def save(self):\n        return 1\n");
  repo.write("web/a.ts", 'import { b } from "./b";\nimport x from "left-pad";\n');
  repo.write("docs/C#.md", "# C#\n");
  repo.write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]));
  repo.write("big.py", `${"x = 1\n".repeat(100)}`);
  repo.write("broken.py", "def ok():\n    pass\n\ndef broken(:\n");
  sha = repo.commit("api, a, assets");
});
afterEach(() => repo.remove());

describe("indexRepo", () => {
  it("indexes every tracked file, sorted, with member ids", async () => {
    const index = await indexRepo(repo.dir, "HEAD", { maxFileBytes: 200 });
    expect(index.sha).toBe(sha);
    expect(index.files.map((f) => f.id)).toEqual([
      "big.py",
      "broken.py",
      "docs/C%23.md",
      "logo.png",
      "src/app/__init__.py",
      "src/app/api.py",
      "src/app/models.py",
      "web/a.ts",
      "web/b.ts",
    ]);
  });

  it("records symbols with member ids and line spans", async () => {
    const index = await indexRepo(repo.dir, "HEAD");
    const models = index.files.find((f) => f.path === "src/app/models.py");
    expect(models?.symbols.map((s) => [s.id, s.startLine, s.endLine])).toEqual([
      ["src/app/models.py#Thing", 1, 3],
      ["src/app/models.py#Thing.save", 2, 3],
    ]);
    expect(models?.language).toBe("python");
    expect(models?.loc).toBe(3);
  });

  it("does not parse binary or oversized files, and flags syntax errors", async () => {
    const index = await indexRepo(repo.dir, "HEAD", { maxFileBytes: 200 });
    const file = (path: string) => index.files.find((f) => f.path === path);
    expect(file("logo.png")).toMatchObject({
      skipped: "binary",
      loc: 0,
      language: null,
      symbols: [],
    });
    expect(file("big.py")).toMatchObject({ skipped: "too-large", loc: 100, symbols: [] });
    expect(file("broken.py")).toMatchObject({ skipped: null, parseError: true });
    expect(file("broken.py")?.symbols.map((s) => s.qualifiedName)).toContain("ok");
    expect(file("docs/C#.md")).toMatchObject({ language: null, skipped: null, loc: 1 });
  });

  it("records each resolved import once, at its first line", async () => {
    const index = await indexRepo(repo.dir, "HEAD");
    expect(index.imports).toEqual([
      { from: "src/app/api.py", to: "src/app/models.py", line: 2 },
      { from: "web/a.ts", to: "web/b.ts", line: 1 },
    ]);
    expect(index.unresolved).toEqual([
      { from: "src/app/api.py", specifier: "os", line: 1, external: true },
      { from: "web/a.ts", specifier: "left-pad", line: 2, external: true },
    ]);
  });

  it("derives co-change from history", async () => {
    const index = await indexRepo(repo.dir, "HEAD");
    expect(index.coChange.commitsConsidered).toBe(2);
    expect(index.coChange.fileCommits["src/app/models.py"]).toBe(2);
    expect(index.coChange.pairs).toContainEqual({
      a: "src/app/models.py",
      b: "web/b.ts",
      count: 1,
    });
  });

  it("indexes an older commit exactly as it was", async () => {
    const first = repo.git("rev-parse", "HEAD~1");
    const index = await indexRepo(repo.dir, first);
    expect(index.files.map((f) => f.path)).toEqual([
      "src/app/__init__.py",
      "src/app/models.py",
      "web/b.ts",
    ]);
    expect(index.coChange.commitsConsidered).toBe(1);
  });

  it("is deterministic", async () => {
    expect(await indexRepo(repo.dir, sha)).toEqual(await indexRepo(repo.dir, sha));
  });

  it("reads the commit, never the working tree, and leaves the repo untouched", async () => {
    repo.write("web/b.ts", "export const b = 2;\nexport function extra() {}\n");
    repo.write("untracked.py", "def u(): pass\n");
    const status = repo.git("status", "--porcelain=v1", "-uall");
    const gitIndex = join(repo.dir, ".git", "index");
    const before = statSync(gitIndex).mtimeMs;

    const index = await indexRepo(repo.dir, "HEAD");

    // Check the index file before running `git status` again: status itself refreshes it.
    expect(statSync(gitIndex).mtimeMs).toBe(before);
    expect(repo.git("status", "--porcelain=v1", "-uall")).toBe(status);
    const b = index.files.find((f) => f.path === "web/b.ts");
    expect(b?.symbols.map((s) => s.qualifiedName)).toEqual(["b"]);
    expect(index.files.some((f) => f.path === "untracked.py")).toBe(false);
  });

  it("rejects a revision that does not exist", async () => {
    await expect(indexRepo(repo.dir, "no-such-branch")).rejects.toThrow(GitError);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run packages/engine/src/index/build-index.test.ts`
Expected: FAIL, because `./build-index.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/engine/src/index/build-index.ts`:
```ts
import { memberId } from "@repowiki/core";
import { type CoChange, computeCoChange, DEFAULT_MAX_FILES_PER_COMMIT } from "./cochange.ts";
import { commitFiles, listBlobs, readBlobs, resolveCommit } from "./git.ts";
import { extractImports, type RawImport } from "./imports.ts";
import { createSourceParser, languageForPath, type SourceLanguage } from "./languages.ts";
import { createResolver, parseWorkspacePackage, type WorkspacePackage } from "./resolve.ts";
import { extractSymbols, type SymbolDef } from "./symbols.ts";

export interface IndexedSymbol extends SymbolDef {
  /** Member id: memberId(path, qualifiedName). */
  id: string;
}

export interface IndexedFile {
  /** Member id for the whole file: memberId(path). */
  id: string;
  path: string;
  language: SourceLanguage | null;
  bytes: number;
  loc: number;
  /** Why the file was not parsed, if it was not. */
  skipped: "binary" | "too-large" | null;
  /** Parsed, but tree-sitter recovered from syntax errors; symbols are best-effort. */
  parseError: boolean;
  symbols: IndexedSymbol[];
}

export interface ImportEdge {
  from: string;
  to: string;
  /** First line in `from` that imports `to`. */
  line: number;
}

export interface UnresolvedImport {
  from: string;
  specifier: string;
  line: number;
  /** stdlib / third-party (true) vs. a repo-internal import RepoWiki could not resolve (false). */
  external: boolean;
}

export interface RepoIndex {
  sha: string;
  files: IndexedFile[];
  imports: ImportEdge[];
  unresolved: UnresolvedImport[];
  coChange: CoChange;
}

export interface IndexOptions {
  maxFileBytes?: number;
  maxFilesPerCommit?: number;
}

export const DEFAULT_MAX_FILE_BYTES = 1_000_000;

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let lines = 0;
  for (const byte of content) if (byte === 0x0a) lines++;
  return content[content.length - 1] === 0x0a ? lines : lines + 1;
}

function specifierOf(raw: RawImport): string {
  return raw.kind === "es" ? raw.specifier : `${".".repeat(raw.level)}${raw.module}`;
}

/** Indexes the commit `rev` of `repo` using read-only git commands; the working tree is never read. */
export async function indexRepo(
  repo: string,
  rev: string,
  options: IndexOptions = {},
): Promise<RepoIndex> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const sha = resolveCommit(repo, rev);
  const blobs = listBlobs(repo, sha);
  const contents = readBlobs(
    repo,
    blobs.map((blob) => blob.oid),
  );
  const read = (oid: string): Buffer => contents.get(oid) ?? Buffer.alloc(0);

  const packages: WorkspacePackage[] = blobs
    .filter((blob) => blob.path === "package.json" || blob.path.endsWith("/package.json"))
    .flatMap((blob) => parseWorkspacePackage(blob.path, read(blob.oid).toString("utf8")) ?? []);
  const resolver = createResolver(
    blobs.map((blob) => blob.path),
    packages,
  );
  const parser = await createSourceParser();

  const files: IndexedFile[] = [];
  const edges = new Map<string, ImportEdge>();
  const unresolved: UnresolvedImport[] = [];

  for (const blob of blobs) {
    const content = read(blob.oid);
    const binary = content.subarray(0, 8000).includes(0);
    const language = languageForPath(blob.path);
    const file: IndexedFile = {
      id: memberId(blob.path),
      path: blob.path,
      language,
      bytes: blob.size,
      loc: binary ? 0 : countLines(content),
      skipped: binary ? "binary" : blob.size > maxFileBytes ? "too-large" : null,
      parseError: false,
      symbols: [],
    };
    files.push(file);
    if (language === null || file.skipped !== null) continue;

    const parsed = parser.parse(language, content.toString("utf8"));
    try {
      file.parseError = parsed.hasError;
      file.symbols = extractSymbols(language, parsed.root).map((s) => ({
        ...s,
        id: memberId(blob.path, s.qualifiedName),
      }));
      for (const raw of extractImports(language, parsed.root)) {
        const { targets, external } = resolver.resolve(blob.path, raw);
        if (targets.length === 0) {
          unresolved.push({
            from: blob.path,
            specifier: specifierOf(raw),
            line: raw.line,
            external,
          });
        }
        for (const to of targets) {
          const key = `${blob.path}\0${to}`;
          const known = edges.get(key);
          if (to !== blob.path && (known === undefined || raw.line < known.line))
            edges.set(key, { from: blob.path, to, line: raw.line });
        }
      }
    } finally {
      parsed.dispose();
    }
  }

  const byPath = (a: { from: string; line: number }, b: { from: string; line: number }) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line;
  return {
    sha,
    files,
    imports: [...edges.values()].sort(
      (a, b) => byPath(a, b) || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
    ),
    unresolved: unresolved.sort((a, b) => byPath(a, b) || (a.specifier < b.specifier ? -1 : 1)),
    coChange: computeCoChange(
      commitFiles(repo, sha),
      new Set(blobs.map((blob) => blob.path)),
      options.maxFilesPerCommit ?? DEFAULT_MAX_FILES_PER_COMMIT,
    ),
  };
}
```

`packages/engine/src/index/index.ts`:
```ts
export {
  DEFAULT_MAX_FILE_BYTES,
  type ImportEdge,
  type IndexedFile,
  type IndexedSymbol,
  type IndexOptions,
  indexRepo,
  type RepoIndex,
  type UnresolvedImport,
} from "./build-index.ts";
export { type CoChange, type CoChangePair, DEFAULT_MAX_FILES_PER_COMMIT } from "./cochange.ts";
export { GitError } from "./git.ts";
export type { SourceLanguage } from "./languages.ts";
export type { SymbolDef, SymbolKind } from "./symbols.ts";
```

Replace `packages/engine/src/index.ts` with the following. Biome sorts export blocks by source, so `./index/` comes before `./store/`.
```ts
export {
  type CoChange,
  type CoChangePair,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES_PER_COMMIT,
  GitError,
  type ImportEdge,
  type IndexedFile,
  type IndexedSymbol,
  type IndexOptions,
  indexRepo,
  type RepoIndex,
  type SourceLanguage,
  type SymbolDef,
  type SymbolKind,
  type UnresolvedImport,
} from "./index/index.ts";
export {
  buildExport,
  type CitingClaim,
  DroppedFeatureError,
  DuplicateManifestError,
  EmptyStoreError,
  type ExportOptions,
  openStore,
  StaleParentError,
  type Store,
  StoreError,
  UnknownFeatureError,
  UnsupportedSchemaError,
  writeExport,
} from "./store/index.ts";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm check`
Expected: PASS (9 new tests). The Task 3 boundary test must still pass: `build-index.ts` imports only from its own module and from `@repowiki/core`.

- [ ] **Step 6: Commit and ship**

```bash
git add packages/engine/src
git commit -m "feat(index): index a commit into a deterministic RepoIndex"
```

Ship. PR title: `feat(index): indexRepo`.

---

### Task 10: Dev command and the next-chief-of-staff run

**Ticket:** `[M2] index: dev command and next-chief-of-staff run`

**Files:**
- Create: `scripts/index-repo.ts`
- Modify: root `package.json` (the `@repowiki/engine` devDependency and the `index:repo` script)

**Interfaces:**
- Consumes: `indexRepo` from `@repowiki/engine` (Task 9).
- Produces: `pnpm index:repo <repo> [rev] [--out file.json]`, which prints a JSON summary and optionally writes the full index. It refuses an `--out` path inside the indexed repo (the spec forbids writing into a documented repo).

- [ ] **Step 1: Branch and wire the workspace dependency**

```bash
git switch -c m2/index-dev-command
pnpm add -D -w --save-exact "@repowiki/engine@workspace:*"
```

Add to the root `package.json` `scripts`: `"index:repo": "node scripts/index-repo.ts"`.

- [ ] **Step 2: Implement**

`scripts/index-repo.ts`:
```ts
import { writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { type IndexedFile, indexRepo } from "@repowiki/engine";

const [repo, rev = "HEAD", ...rest] = process.argv.slice(2);
if (repo === undefined) {
  console.error("usage: pnpm index:repo <repo-path> [rev] [--out file.json]");
  process.exit(2);
}
const outFlag = rest.indexOf("--out");
const out = outFlag === -1 ? null : (rest[outFlag + 1] ?? null);
if (out !== null && resolve(out).startsWith(resolve(repo) + sep)) {
  console.error("refusing to write inside the indexed repository; choose an --out path elsewhere");
  process.exit(2);
}

const started = performance.now();
const index = await indexRepo(repo, rev);
const count = (keep: (file: IndexedFile) => boolean) => index.files.filter(keep).length;
const summary = {
  sha: index.sha,
  files: index.files.length,
  byLanguage: {
    python: count((f) => f.language === "python"),
    typescript: count((f) => f.language === "typescript"),
    tsx: count((f) => f.language === "tsx"),
    fileLevel: count((f) => f.language === null),
  },
  skipped: {
    binary: count((f) => f.skipped === "binary"),
    tooLarge: count((f) => f.skipped === "too-large"),
  },
  parseErrors: count((f) => f.parseError),
  symbols: index.files.reduce((total, f) => total + f.symbols.length, 0),
  importEdges: index.imports.length,
  externalImports: index.unresolved.filter((u) => u.external).length,
  unresolvedInternal: index.unresolved.filter((u) => !u.external).length,
  coChange: {
    commitsConsidered: index.coChange.commitsConsidered,
    commitsSkipped: index.coChange.commitsSkipped,
    pairs: index.coChange.pairs.length,
  },
  ms: Math.round(performance.now() - started),
};
if (out !== null) writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
```

- [ ] **Step 3: Run it on both acceptance targets**

```bash
pnpm check
pnpm index:repo ../next-chief-of-staff 7247d28
pnpm index:repo . HEAD
git -C ../next-chief-of-staff status --porcelain > /tmp/before.txt
pnpm index:repo ../next-chief-of-staff 7247d28 --out ../next-chief-of-staff/index.json; echo "exit $?"
git -C ../next-chief-of-staff status --porcelain | diff /tmp/before.txt - && echo untouched
```

Expected:
- **next-chief-of-staff at `7247d28`:** `parseErrors: 0` and `unresolvedInternal: 0`. These two are the M2 exit gate. The prototype measured `files 429` (python 153, typescript 12, tsx 30, fileLevel 234, binary 2), `symbols 2185`, `importEdges 496`, `externalImports 572`, `commitsConsidered 433`, `commitsSkipped 7`, `pairs 3498`. Report any difference from these numbers in the PR body.
- **RepoWiki at HEAD:** `parseErrors: 0` and `unresolvedInternal: 0`. The `@repowiki/*` imports resolve through workspace packages.
- **The `--out` inside the repo:** exits 2 with the refusal message and prints `untouched`. next-chief-of-staff has a pre-existing uncommitted edit to `frontend/src/views/ProjectView.tsx`. That edit is the owner's, so leave it alone. It is also a live check that the index reflects the sha, not the working tree.

- [ ] **Step 4: Commit and ship**

```bash
git add scripts/index-repo.ts package.json pnpm-lock.yaml
git commit -m "feat(index): add index:repo dev command"
```

Ship. PR title: `feat(index): dev command and next-chief-of-staff run`. Paste both JSON summaries into the PR body.
