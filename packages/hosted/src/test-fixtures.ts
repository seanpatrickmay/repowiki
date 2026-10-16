import type { PortfolioContent } from "./content.ts";
import type {
  Account,
  DraftRevision,
  EligibilityFacts,
  Generation,
  Job,
  Preview,
  Project,
  PublishedVersion,
  Review,
} from "./entities.ts";

/** Test-only builders: one valid example of each entity, patched per test. */
export const T0 = "2026-10-14T12:00:00Z";
export const SHA = "a".repeat(40);
export const HASH = "b".repeat(64);
export const ids = {
  account: "00000000-0000-4000-8000-000000000001",
  other: "00000000-0000-4000-8000-000000000002",
  project: "00000000-0000-4000-8000-000000000003",
  job: "00000000-0000-4000-8000-000000000004",
  generation: "00000000-0000-4000-8000-000000000005",
  generation2: "00000000-0000-4000-8000-000000000006",
} as const;

export const anAccount = (patch: Partial<Account> = {}): Account => ({
  id: ids.account,
  githubUserId: 101,
  login: "sean",
  displayName: "Sean May",
  githubCreatedAt: "2019-01-01T00:00:00Z",
  plan: "free",
  status: "active",
  createdAt: T0,
  ...patch,
});

export const aProject = (patch: Partial<Project> = {}): Project => ({
  id: ids.project,
  accountId: ids.account,
  githubRepoId: 202,
  slug: "repowiki",
  state: "draft",
  withdrawReason: null,
  withdrawnAt: null,
  unavailableSince: null,
  latestRevision: 0,
  currentVersion: 0,
  createdAt: T0,
  ...patch,
});

export const aJob = (patch: Partial<Job> = {}): Job => ({
  id: ids.job,
  projectId: ids.project,
  kind: "generate",
  commitSha: SHA,
  status: "queued",
  step: null,
  attempt: 1,
  leaseExpiresAt: null,
  estimateUsdMicros: 400_000,
  capUsdMicros: 600_000,
  spentUsdMicros: 0,
  refusal: null,
  createdAt: T0,
  startedAt: null,
  finishedAt: null,
  ...patch,
});

export const aGeneration = (patch: Partial<Generation> = {}): Generation => ({
  id: ids.generation,
  jobId: ids.job,
  projectId: ids.project,
  commitSha: SHA,
  exportKey: `exports/${ids.generation}.json`,
  exportHash: HASH,
  suggestions: {
    tagline: "A citation-backed wiki for a git repository",
    summary: "RepoWiki turns a repository into a wiki whose every claim cites the code.",
    contributionDraft: "I built the indexing and verification pipeline.",
    highlightCandidates: ["indexing", "verify"],
  },
  facts: {
    languages: [{ name: "TypeScript", share: 0.97 }],
    indexedFiles: 585,
    featureIds: ["indexing", "verify", "site"],
    author: {
      commits: 600,
      totalCommits: 620,
      currentLines: 40_000,
      totalLines: 41_000,
      features: [{ featureId: "indexing", commits: 120, currentLines: 9000 }],
    },
    technologies: [],
  },
  engineVersion: "0.0.0",
  models: ["claude-haiku-4-5"],
  spentUsdMicros: 580_800,
  createdAt: T0,
  ...patch,
});

export const aContent = (patch: Partial<PortfolioContent> = {}): PortfolioContent => ({
  contribution: "I built the indexing and verification pipeline.",
  ...patch,
});

export const aRevision = (patch: Partial<DraftRevision> = {}): DraftRevision => ({
  projectId: ids.project,
  number: 1,
  generationId: ids.generation,
  content: aContent(),
  createdAt: T0,
  ...patch,
});

export const aReview = (patch: Partial<Review> = {}): Review => ({
  projectId: ids.project,
  revision: 1,
  attestationVersion: 2,
  createdAt: T0,
  ...patch,
});

export const aPreview = (patch: Partial<Preview> = {}): Preview => ({
  projectId: ids.project,
  revision: 1,
  siteKey: `previews/${ids.project}/r1/`,
  siteHash: HASH,
  createdAt: T0,
  ...patch,
});

export const eligibleFacts = (patch: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  checkedAt: T0,
  githubUserId: 101,
  githubRepoId: 202,
  fullName: "seanpatrickmay/repowiki",
  visibility: "public",
  isFork: false,
  permission: "admin",
  authoredCommits: 600,
  indexedFiles: 585,
  tokenValid: true,
  ...patch,
});

export const aPublishedVersion = (patch: Partial<PublishedVersion> = {}): PublishedVersion => ({
  projectId: ids.project,
  version: 1,
  revision: 1,
  siteKey: `sites/${ids.project}/v1/`,
  siteHash: HASH,
  authorization: eligibleFacts(),
  publishedAt: T0,
  ...patch,
});
