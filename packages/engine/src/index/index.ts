export { type AuthoredCommit, type AuthoredFile, readAuthorship } from "./authorship.ts";
export { BLAME_TIMEOUT_MS, type BlameRun, blameFile, parseIncrementalBlame } from "./blame.ts";
export { MAX_BLOB_BYTES, readBlobAt } from "./blob.ts";
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
export type { CallEdge } from "./calls.ts";
export { type CoChange, type CoChangePair, DEFAULT_MAX_FILES_PER_COMMIT } from "./cochange.ts";
export {
  diffCommits,
  diffTrees,
  type FileChange,
  type Hunk,
  isAncestor,
  parseHunks,
  type ReplayStep,
  reachableCommits,
  replaySteps,
} from "./diff.ts";
export {
  assertOid,
  assertSha,
  GitError,
  type GitOptions,
  GitTimeoutError,
  gitFailureCause,
  isSha,
  listBlobs,
  resolveCommit,
  scrubbedGitEnv,
  streamBlobs,
  type TreeBlob,
} from "./git.ts";
export { type CommitInfo, pullRequestOf, readHistory, readSources } from "./history.ts";
export type { SourceLanguage } from "./languages.ts";
export type { SymbolDef, SymbolKind } from "./symbols.ts";
/** Test-only: scripted git repositories (spec §8's fixture repo builder), for other modules' tests. */
export { createTestRepo, type TestAuthor, type TestRepo } from "./test-repo.ts";
export { configuredEmail } from "./user-email.ts";
