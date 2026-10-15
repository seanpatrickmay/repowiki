import { GitSha, IsoDateTime, Sha256Hex } from "@repowiki/core";
import { z } from "zod";
import { Facts, Overrides, Suggestions } from "./content.ts";
import { Plan } from "./limits.ts";
import { RefusalCode } from "./refusals.ts";
import { HandleName, HandleState, Slug } from "./urls.ts";

export const Uuid = z.uuidv4();
export const GithubId = z.int().positive();
export const UsdMicros = z.int().nonnegative();
const ObjectKey = z.string().min(1).max(512);
const Ordinal = z.int().positive();
const Count = z.int().nonnegative();

export const Account = z.strictObject({
  id: Uuid,
  githubUserId: GithubId,
  login: z.string().min(1).max(39),
  displayName: z.string().min(1).max(120),
  githubCreatedAt: IsoDateTime,
  plan: Plan,
  status: z.enum(["active", "deleting"]),
  createdAt: IsoDateTime,
});
export type Account = z.infer<typeof Account>;

export const Handle = z
  .strictObject({
    handle: HandleName,
    accountId: Uuid,
    state: HandleState,
    redirectTo: HandleName.nullable(),
    createdAt: IsoDateTime,
  })
  .refine((h) => (h.state === "redirect") === (h.redirectTo !== null), "redirectTo mismatch");
export type Handle = z.infer<typeof Handle>;

export const Repository = z.strictObject({
  githubRepoId: GithubId,
  fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "expected owner/name"),
  visibility: z.enum(["public", "private"]),
  isFork: z.boolean(),
  defaultBranch: z.string().min(1).max(255),
  checkedAt: IsoDateTime,
});
export type Repository = z.infer<typeof Repository>;

export const ProjectState = z.enum(["draft", "published", "withdrawn", "purged"]);
export type ProjectState = z.infer<typeof ProjectState>;
export const WithdrawReason = z.enum(["author", "repository", "operator", "account-deleted"]);
export type WithdrawReason = z.infer<typeof WithdrawReason>;

export const Project = z
  .strictObject({
    id: Uuid,
    accountId: Uuid,
    githubRepoId: GithubId,
    slug: Slug,
    state: ProjectState,
    withdrawReason: WithdrawReason.nullable(),
    withdrawnAt: IsoDateTime.nullable(),
    /** When the daily check found the repository gone; the 30-day purge clock runs from here. */
    unavailableSince: IsoDateTime.nullable(),
    latestRevision: Count,
    currentVersion: Count,
    createdAt: IsoDateTime,
  })
  .refine((p) => {
    const gone = p.state === "withdrawn" || p.state === "purged";
    return gone === (p.withdrawReason !== null) && gone === (p.withdrawnAt !== null);
  }, "a reason and time exactly when withdrawn or purged")
  .refine(
    (p) =>
      (p.unavailableSince === null || p.state === "withdrawn" || p.state === "purged") &&
      (p.withdrawReason !== "repository" || p.unavailableSince !== null),
    "unavailableSince only on withdrawn or purged projects, and always on repository withdrawals",
  )
  .refine((p) => p.state !== "published" || p.currentVersion > 0, "published without a version");
export type Project = z.infer<typeof Project>;

/** The pipeline steps a job reports, in order (§6.1); they drive the progress display only. */
export const JOB_STEPS = [
  "fetch",
  "index",
  "cluster",
  "manifest",
  "write",
  "verify",
  "people",
  "facts",
  "render",
] as const;
export const JobStep = z.enum(JOB_STEPS);
export type JobStep = z.infer<typeof JobStep>;
export const JobKind = z.enum(["generate", "refresh"]);
export type JobKind = z.infer<typeof JobKind>;
export const JobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z
  .strictObject({
    id: Uuid,
    projectId: Uuid,
    kind: JobKind,
    commitSha: GitSha,
    status: JobStatus,
    step: JobStep.nullable(),
    attempt: z.int().min(1).max(3),
    leaseExpiresAt: IsoDateTime.nullable(),
    estimateUsdMicros: UsdMicros,
    capUsdMicros: UsdMicros,
    spentUsdMicros: UsdMicros,
    refusal: RefusalCode.nullable(),
    createdAt: IsoDateTime,
    startedAt: IsoDateTime.nullable(),
    finishedAt: IsoDateTime.nullable(),
  })
  .refine((j) => (j.status === "failed") === (j.refusal !== null), "a refusal exactly when failed")
  .refine((j) => j.estimateUsdMicros <= j.capUsdMicros, "estimate above cap")
  .refine((j) => j.spentUsdMicros <= j.capUsdMicros, "spend above cap");
export type Job = z.infer<typeof Job>;

export const Generation = z
  .strictObject({
    id: Uuid,
    jobId: Uuid,
    projectId: Uuid,
    commitSha: GitSha,
    exportKey: ObjectKey,
    exportHash: Sha256Hex,
    suggestions: Suggestions,
    facts: Facts,
    engineVersion: z.string().min(1).max(64),
    models: z.array(z.string().min(1).max(128)).min(1),
    spentUsdMicros: UsdMicros,
    createdAt: IsoDateTime,
  })
  .refine(
    (g) => g.suggestions.highlightCandidates.every((id) => g.facts.featureIds.includes(id)),
    "a suggested highlight the wiki does not have",
  );
export type Generation = z.infer<typeof Generation>;

/** Why a revision cannot be reviewed yet (§6.3). */
export const RevisionFlag = z
  .string()
  .regex(
    /^(?:suggestion-changed:(?:tagline|summary|contribution)|highlight-missing:[a-z0-9]+(?:-[a-z0-9]+)*)$/,
    "unknown revision flag",
  );
export type RevisionFlag = z.infer<typeof RevisionFlag>;

export const DraftRevision = z.strictObject({
  projectId: Uuid,
  number: Ordinal,
  generationId: Uuid,
  overrides: Overrides,
  flags: z.array(RevisionFlag),
  source: z.enum(["generation", "author"]),
  createdAt: IsoDateTime,
});
export type DraftRevision = z.infer<typeof DraftRevision>;

export const Review = z.strictObject({
  projectId: Uuid,
  revision: Ordinal,
  attestationVersion: z.literal(1),
  createdAt: IsoDateTime,
});
export type Review = z.infer<typeof Review>;

export const Preview = z.strictObject({
  projectId: Uuid,
  revision: Ordinal,
  siteKey: ObjectKey,
  siteHash: Sha256Hex,
  createdAt: IsoDateTime,
});
export type Preview = z.infer<typeof Preview>;

export const Permission = z.enum(["admin", "maintain", "push", "triage", "pull", "none"]);
export type Permission = z.infer<typeof Permission>;

/** What GitHub said about the user and repository at one moment (§7.2). */
export const EligibilityFacts = z.strictObject({
  checkedAt: IsoDateTime,
  githubUserId: GithubId,
  githubRepoId: GithubId,
  fullName: z.string().min(1).max(201),
  visibility: z.enum(["public", "private"]),
  isFork: z.boolean(),
  permission: Permission,
  authoredCommits: z.int().min(0).max(1000),
  indexedFiles: Count.nullable(),
  tokenValid: z.boolean(),
});
export type EligibilityFacts = z.infer<typeof EligibilityFacts>;

export const PublishedVersion = z.strictObject({
  projectId: Uuid,
  version: Ordinal,
  revision: Ordinal,
  siteKey: ObjectKey,
  siteHash: Sha256Hex,
  authorization: EligibilityFacts,
  publishedAt: IsoDateTime,
});
export type PublishedVersion = z.infer<typeof PublishedVersion>;

export const LedgerEntry = z
  .strictObject({
    id: Uuid,
    accountId: Uuid,
    jobId: Uuid,
    kind: z.enum(["reserve", "spend", "release", "quota"]),
    usdMicros: UsdMicros,
    quota: z.enum(["generation", "refresh"]).nullable(),
    createdAt: IsoDateTime,
  })
  .refine((e) => (e.kind === "quota") === (e.quota !== null), "a quota exactly on quota entries");
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** Everything a person can ask to do (§7.1). */
export const ACTIONS = [
  "public.read",
  "repos.list",
  "job.create",
  "job.refresh",
  "job.read",
  "job.cancel",
  "job.retry",
  "draft.read",
  "preview.read",
  "draft.save",
  "draft.review",
  "project.publish",
  "project.unpublish",
  "project.export",
  "project.restore",
  "account.delete",
  "project.takedown",
  "project.reinstate",
] as const;
export const Action = z.enum(ACTIONS);
export type Action = z.infer<typeof Action>;
export const Actor = z.enum(["anonymous", "author", "other", "system", "operator"]);
export type Actor = z.infer<typeof Actor>;

export const AuditEvent = z.strictObject({
  id: Uuid,
  actor: Actor,
  /** A person's action, or a system event such as "job.lease" or "project.purge". */
  action: z.string().regex(/^[a-z]+\.[a-z-]+$/),
  target: z.strictObject({
    entity: z.enum(["account", "handle", "project", "job", "revision", "version"]),
    id: z.string().min(1).max(128),
  }),
  outcome: z.union([z.literal("allowed"), RefusalCode]),
  createdAt: IsoDateTime,
});
export type AuditEvent = z.infer<typeof AuditEvent>;
