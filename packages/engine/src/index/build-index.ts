import { memberId, RepoPath } from "@repowiki/core";
import {
  type CallEdge,
  type CallSite,
  extractBindings,
  extractCalls,
  type ResolvedBinding,
  resolveBinding,
  resolveCalls,
} from "./calls.ts";
import { type CoChange, computeCoChange, DEFAULT_MAX_FILES_PER_COMMIT } from "./cochange.ts";
import {
  commitFiles,
  GitError,
  type GitOptions,
  listBlobs,
  resolveCommit,
  type StreamedBlob,
  streamBlobs,
  type TreeBlob,
} from "./git.ts";
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
  /** Calls between indexed symbols, resolved by name through imports (spec §4; diagrams use them). */
  calls: CallEdge[];
  /** Tracked paths excluded because they are not valid RepoPaths (e.g. contain a backslash), sorted. */
  invalidPaths: string[];
  unresolved: UnresolvedImport[];
  coChange: CoChange;
}

export interface IndexOptions {
  maxFileBytes?: number;
  maxFilesPerCommit?: number;
  /** How every git command of the index runs (work in flight's own object store, C13). */
  git?: GitOptions;
}

export const DEFAULT_MAX_FILE_BYTES = 1_000_000;

/** The blobs paired with their streamed contents, in order; a blob git did not return is an error. */
async function* withContents(
  repo: string,
  blobs: readonly TreeBlob[],
  holdLimit: number,
  options: GitOptions = {},
): AsyncGenerator<[TreeBlob, StreamedBlob], void, undefined> {
  let next = 0;
  for await (const data of streamBlobs(
    repo,
    blobs.map((blob) => blob.oid),
    holdLimit,
    options,
  )) {
    const blob = blobs[next++] as TreeBlob;
    if (data.oid !== blob.oid) {
      throw new GitError(`cat-file returned ${data.oid} for ${blob.path} (${blob.oid})`);
    }
    yield [blob, data];
  }
  const missing = blobs[next];
  if (missing !== undefined) {
    throw new GitError(`missing content for ${missing.path} (${missing.oid})`);
  }
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
  if (!Number.isFinite(maxFileBytes) || maxFileBytes < 0) {
    throw new RangeError(`maxFileBytes must be a finite, non-negative number, got ${maxFileBytes}`);
  }
  const gitOptions = options.git ?? {};
  const sha = resolveCommit(repo, rev, gitOptions);
  const listed = listBlobs(repo, sha, gitOptions);
  const isValid = (blob: TreeBlob) => RepoPath.safeParse(blob.path).success;
  const blobs = listed.filter(isValid);
  const invalidPaths = listed
    .filter((blob) => !isValid(blob))
    .map((blob) => blob.path)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Pass 1: the manifests alone, parsed whole (they are read in full whatever their size), because
  // the resolver needs every workspace package before any file is resolved.
  const manifests = blobs.filter(
    (blob) => blob.path === "package.json" || blob.path.endsWith("/package.json"),
  );
  const packages: WorkspacePackage[] = [];
  for await (const [blob, data] of withContents(
    repo,
    manifests,
    Number.POSITIVE_INFINITY,
    gitOptions,
  )) {
    const parsed = parseWorkspacePackage(blob.path, data.content?.toString("utf8") ?? "");
    if (parsed !== null) packages.push(parsed);
  }
  const resolver = createResolver(
    blobs.map((blob) => blob.path),
    packages,
  );
  const parser = await createSourceParser();

  const files: IndexedFile[] = [];
  const edges = new Map<string, ImportEdge>();
  const unresolved: UnresolvedImport[] = [];
  const callSites: { file: IndexedFile; calls: CallSite[]; bindings: ResolvedBinding[] }[] = [];

  // Pass 2: one blob at a time; a blob over maxFileBytes is only counted and sniffed in transit.
  for await (const [blob, data] of withContents(repo, blobs, maxFileBytes, gitOptions)) {
    const content = data.content;
    const binary = data.head.includes(0);
    const language = languageForPath(blob.path);
    const file: IndexedFile = {
      id: memberId(blob.path),
      path: blob.path,
      language,
      bytes: blob.size,
      loc: binary ? 0 : data.lines,
      skipped: binary ? "binary" : blob.size > maxFileBytes ? "too-large" : null,
      parseError: false,
      symbols: [],
    };
    files.push(file);
    if (language === null || file.skipped !== null || content === null) continue;

    const parsed = parser.parse(language, content.toString("utf8"));
    try {
      file.parseError = parsed.hasError;
      file.symbols = extractSymbols(language, parsed.root, parser).map((s) => ({
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
      const bindings = extractBindings(language, parsed.root).flatMap(
        (binding) =>
          resolveBinding(binding, resolver.resolve(blob.path, binding.raw).targets) ?? [],
      );
      callSites.push({ file, calls: extractCalls(language, parsed.root), bindings });
    } finally {
      parsed.dispose();
    }
  }

  const symbolsByPath = new Map(files.map((file) => [file.path, file.symbols]));
  const calls = callSites
    .flatMap(({ file, calls: sites, bindings }) =>
      resolveCalls(file, sites, bindings, (path) => symbolsByPath.get(path) ?? []),
    )
    .sort((a, b) =>
      a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
    );

  const byPath = (a: { from: string; line: number }, b: { from: string; line: number }) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line;
  return {
    sha,
    files,
    invalidPaths,
    calls,
    imports: [...edges.values()].sort(
      (a, b) => byPath(a, b) || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
    ),
    unresolved: unresolved.sort((a, b) => byPath(a, b) || (a.specifier < b.specifier ? -1 : 1)),
    coChange: computeCoChange(
      commitFiles(repo, sha, gitOptions),
      new Set(blobs.map((blob) => blob.path)),
      options.maxFilesPerCommit ?? DEFAULT_MAX_FILES_PER_COMMIT,
    ),
  };
}
