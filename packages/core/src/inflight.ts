import { z } from "zod";
import { INVISIBLE_CHARACTERS } from "./alias.ts";
import { CodeCitation } from "./citation.ts";
import { CLAIM_TEXT_MAX_LENGTH, ClaimId } from "./claim.ts";
import { FeatureId } from "./feature.ts";
import type { Manifest } from "./manifest.ts";
import { GitSha, IsoDateTime, RepoPath } from "./primitives.ts";
import { type Revision, TokenUsage } from "./revision.ts";

/** The most open pull requests and issues a snapshot keeps, the most recently updated (R19). */
export const INFLIGHT_MAX_PULLS = 50;
export const INFLIGHT_MAX_ISSUES = 200;
/** The most changed files stored per pull request, and the most GitHub's file list gives (R19). */
export const INFLIGHT_MAX_FILES = 300;
export const INFLIGHT_API_FILES = 100;
/** Labels kept per pull request or issue, and closing references kept per pull request. */
export const INFLIGHT_MAX_LABELS = 10;
export const INFLIGHT_MAX_CLOSES = 10;
/** Code points of a stored body (store only, never exported) and of each one-line field (R13). */
export const INFLIGHT_BODY_MAX_LENGTH = 4000;
export const INFLIGHT_TITLE_MAX_LENGTH = 200;
export const INFLIGHT_LABEL_MAX_LENGTH = 50;
export const INFLIGHT_BRANCH_MAX_LENGTH = 100;
export const INFLIGHT_EVIDENCE_MAX_LENGTH = 120;
export const INFLIGHT_REASON_MAX_LENGTH = 300;
/** Code points of a changed file's path from GitHub or git (R13). */
export const INFLIGHT_PATH_MAX_LENGTH = 4096;
/** A summary's claims, each claim's citations and features, and an issue's features (R10, R12). */
export const INFLIGHT_MAX_SUMMARY_CLAIMS = 5;
export const INFLIGHT_MAX_CLAIM_CITATIONS = 3;
export const INFLIGHT_MAX_CLAIM_FEATURES = 3;
export const INFLIGHT_MAX_ISSUE_FEATURES = 3;

/** A GitHub login and owner (a user or an organisation), and a repository name (R13, R24). */
export const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;
export const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Untrusted GitHub text as one line (R13): every control or invisible character (newlines and tabs
 * included) becomes a space, runs of whitespace collapse, and the text is cut to `max` code points
 * with "…". Nothing is escaped: each medium escapes for itself (Astro, the terminal, a prompt).
 */
export function inflightLine(text: string, max: number): string {
  const chars = [...text.replace(INVISIBLE_CHARACTERS, " ").replace(/\s+/g, " ").trim()];
  if (chars.length <= max) return chars.join("");
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * A pull request's or issue's body as the store keeps it (R13): every control or invisible
 * character replaced by a space, so it is one line however it was written, cut to
 * INFLIGHT_BODY_MAX_LENGTH code points. Never exported, rendered or printed.
 */
export function inflightBody(text: string): string {
  return [...text.replace(INVISIBLE_CHARACTERS, " ")].slice(0, INFLIGHT_BODY_MAX_LENGTH).join("");
}

/** A string that inflightLine leaves as it is: one neutralised line of at most `max` code points. */
const line = (max: number) =>
  z
    .string()
    .min(1)
    .refine(
      (text) => inflightLine(text, max) === text,
      `expected one plain line of at most ${max}`,
    );

const count = z.int().nonnegative();
const number = z.int().positive();

/**
 * Whether a changed file's path is safe to store, show and prompt with (R13): a repo-relative
 * path of at most INFLIGHT_PATH_MAX_LENGTH code points that inflightLine leaves as it is, so it
 * holds no control, line-break, tab or bidi character. Ingest drops (and counts) one that is not.
 */
export function isInflightPath(path: string): boolean {
  return RepoPath.safeParse(path).success && inflightLine(path, INFLIGHT_PATH_MAX_LENGTH) === path;
}

/** A changed file's path as the snapshot stores it: see isInflightPath. */
export const InflightPath = RepoPath.refine(
  isInflightPath,
  `expected one plain path of at most ${INFLIGHT_PATH_MAX_LENGTH}`,
);

/** The documented repository on GitHub (R24). Every URL the site shows is built from it. */
export const GitHubRepo = z.object({
  host: z.literal("github.com"),
  owner: z.string().regex(GITHUB_LOGIN),
  name: z
    .string()
    .regex(GITHUB_NAME)
    .refine((name) => name !== "." && name !== "..", "not a repository name"),
  private: z.boolean(),
  defaultBranch: line(INFLIGHT_BRANCH_MAX_LENGTH),
});
export type GitHubRepo = z.infer<typeof GitHubRepo>;

/**
 * Who opened a pull request or issue: a validated login, never an email (C8); null for a deleted
 * account or a login that fails the pattern.
 */
export const Author = z
  .object({ login: z.string().regex(GITHUB_LOGIN), bot: z.boolean() })
  .nullable();
export type Author = z.infer<typeof Author>;

/** One summary claim: model text in the claim subset, citing 1-3 changed ranges at the PR head. */
export const InFlightClaim = z.object({
  id: ClaimId,
  text: z.string().min(1).max(CLAIM_TEXT_MAX_LENGTH),
  citations: z.array(CodeCitation).min(1).max(INFLIGHT_MAX_CLAIM_CITATIONS),
  features: z.array(FeatureId).max(INFLIGHT_MAX_CLAIM_FEATURES),
});
export type InFlightClaim = z.infer<typeof InFlightClaim>;

export const InFlightSummary = z.object({
  model: z.string().min(1),
  generatedAt: IsoDateTime,
  tokens: TokenUsage,
  claims: z.array(InFlightClaim).min(1).max(INFLIGHT_MAX_SUMMARY_CLAIMS),
});
export type InFlightSummary = z.infer<typeof InFlightSummary>;

/**
 * One file a pull request changes, with the feature it belongs to: a manifest member's
 * ("member"), a new file's as placement infers it ("inferred"), or none for a file the PR deletes
 * that the wiki's head no longer has ("none").
 */
export const InFlightFile = z
  .object({
    path: InflightPath,
    oldPath: InflightPath.nullable(),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    additions: count,
    deletions: count,
    featureId: FeatureId.nullable(),
    placement: z.enum(["member", "inferred", "none"]),
  })
  .refine((file) => (file.featureId === null) === (file.placement === "none"), {
    message: "a file has a feature unless its placement is none",
    path: ["featureId"],
  });
export type InFlightFile = z.infer<typeof InFlightFile>;

/** What a pull request does to one feature (R8). `churn` is null where it would be infinite. */
export const InFlightFeature = z.object({
  featureId: FeatureId,
  files: count,
  changedLines: count,
  added: count,
  removed: count,
  churn: z.number().nonnegative().nullable(),
  drifts: z.boolean(),
});
export type InFlightFeature = z.infer<typeof InFlightFeature>;

/** A claim on a current page the pull request would make stale if it merged now (R7). */
export const InFlightEffect = z.object({
  featureId: FeatureId,
  revisionId: z.string().min(1),
  claimId: ClaimId,
  reason: line(INFLIGHT_REASON_MAX_LENGTH),
  /** False: the merge conflicts or git is too old to merge, so the claim only may change. */
  certain: z.boolean(),
});
export type InFlightEffect = z.infer<typeof InFlightEffect>;

const labels = z.array(line(INFLIGHT_LABEL_MAX_LENGTH)).max(INFLIGHT_MAX_LABELS);

export const InFlightPull = z
  .object({
    number,
    title: line(INFLIGHT_TITLE_MAX_LENGTH),
    author: Author,
    draft: z.boolean(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    baseRef: line(INFLIGHT_BRANCH_MAX_LENGTH),
    labels,
    /** Open issues of the snapshot it closes. */
    closes: z.array(number).max(INFLIGHT_MAX_CLOSES),
    head: z.enum(["fetched", "missing", "moved"]),
    headSha: GitSha,
    mergeBase: GitSha.nullable(),
    merge: z.enum(["clean", "conflicts", "unknown"]),
    files: z.array(InFlightFile).max(INFLIGHT_MAX_FILES),
    /** Changed files beyond those listed. */
    filesTruncated: count,
    /** Heaviest first. */
    features: z.array(InFlightFeature),
    effects: z.array(InFlightEffect),
    summary: InFlightSummary.nullable(),
  })
  .superRefine((pull, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    if (pull.head !== "fetched") {
      if (pull.files.length > 0) issue("a pull request without its head lists no file", ["files"]);
      if (pull.effects.length > 0)
        issue("a pull request without its head has no effect", ["effects"]);
      if (pull.merge !== "unknown")
        issue("a pull request without its head has no merge", ["merge"]);
      if (pull.summary !== null)
        issue("a pull request without its head has no summary", ["summary"]);
    }
    const touched = new Set(pull.features.map((f) => f.featureId));
    if (touched.size !== pull.features.length) issue("a feature is listed twice", ["features"]);
    pull.summary?.claims.forEach((claim, c) => {
      claim.citations.forEach((citation, i) => {
        if (citation.sha !== pull.headSha)
          issue("a summary claim cites the pull request's head", [
            "summary",
            "claims",
            c,
            "citations",
            i,
          ]);
      });
      for (const id of claim.features) {
        if (!touched.has(id))
          issue(`a summary claim names ${id}, which the pull request does not touch`, [
            "summary",
            "claims",
            c,
            "features",
          ]);
      }
    });
  });
export type InFlightPull = z.infer<typeof InFlightPull>;

/** Why an issue maps to a feature, strongest first: pull, path, name, label, then search (R12). */
export const IssueEvidence = z.object({
  featureId: FeatureId,
  kind: z.enum(["pull", "path", "name", "label", "search"]),
  /** The PR number, path, phrase or label the mapping rests on. */
  detail: line(INFLIGHT_EVIDENCE_MAX_LENGTH),
});
export type IssueEvidence = z.infer<typeof IssueEvidence>;

export const InFlightIssue = z
  .object({
    number,
    title: line(INFLIGHT_TITLE_MAX_LENGTH),
    author: Author,
    labels,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    features: z.array(IssueEvidence).max(INFLIGHT_MAX_ISSUE_FEATURES),
    /** Open pull requests of the snapshot that close it. */
    pulls: z.array(number),
  })
  .refine(
    (issue) => new Set(issue.features.map((e) => e.featureId)).size === issue.features.length,
    {
      message: "a feature is named twice",
      path: ["features"],
    },
  );
export type InFlightIssue = z.infer<typeof InFlightIssue>;

/** The derived work-in-flight snapshot the export carries (spec v2 #9 §5.1). */
export const InFlight = z
  .object({
    repo: GitHubRepo,
    /** When GitHub was read. */
    fetchedAt: IsoDateTime,
    /** When the impacts were last computed, and against which wiki head. */
    derivedAt: IsoDateTime,
    wikiHead: GitSha,
    /** Most recently updated first. */
    pulls: z.array(InFlightPull).max(INFLIGHT_MAX_PULLS),
    issues: z.array(InFlightIssue).max(INFLIGHT_MAX_ISSUES),
    /** Open pull requests and issues beyond the caps. */
    omitted: z.object({ pulls: count, issues: count }),
  })
  .superRefine((inflight, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    const pulls = new Map(inflight.pulls.map((p) => [p.number, p]));
    const issues = new Map(inflight.issues.map((i) => [i.number, i]));
    if (pulls.size !== inflight.pulls.length) issue("two pull requests share a number", ["pulls"]);
    if (issues.size !== inflight.issues.length) issue("two issues share a number", ["issues"]);
    inflight.pulls.forEach((pull, p) => {
      for (const n of pull.closes) {
        if (!issues.get(n)?.pulls.includes(pull.number))
          issue(`#${pull.number} closes #${n}, which does not list it`, ["pulls", p, "closes"]);
      }
    });
    inflight.issues.forEach((open, i) => {
      for (const n of open.pulls) {
        if (!pulls.get(n)?.closes.includes(open.number))
          issue(`#${open.number} lists #${n}, which does not close it`, ["issues", i, "pulls"]);
      }
    });
  });
export type InFlight = z.infer<typeof InFlight>;

/** A pull request as the snapshot stores it: what GitHub states, normalised (R13, R19). */
export const GitHubPull = z.object({
  number,
  title: line(INFLIGHT_TITLE_MAX_LENGTH),
  body: z.string().refine((body) => inflightBody(body) === body, "expected a neutralised body"),
  author: Author,
  draft: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  baseRef: line(INFLIGHT_BRANCH_MAX_LENGTH),
  headRefOid: GitSha,
  labels,
  /** Issues it closes, as GitHub lists them (open or not). */
  closes: z.array(number).max(INFLIGHT_MAX_CLOSES),
  /** GitHub's first INFLIGHT_API_FILES changed paths: the file list of a PR whose head is not fetched. */
  files: z.array(InflightPath).max(INFLIGHT_API_FILES),
  filesTotal: count,
});
export type GitHubPull = z.infer<typeof GitHubPull>;

export const GitHubIssue = z.object({
  number,
  title: line(INFLIGHT_TITLE_MAX_LENGTH),
  body: z.string().refine((body) => inflightBody(body) === body, "expected a neutralised body"),
  author: Author,
  labels,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GitHubIssue = z.infer<typeof GitHubIssue>;

/** The normalised GitHub answer, kept in the store only: it holds bodies, so it is never exported. */
export const GitHubSnapshot = z
  .object({
    repo: GitHubRepo,
    fetchedAt: IsoDateTime,
    pulls: z.array(GitHubPull).max(INFLIGHT_MAX_PULLS),
    issues: z.array(GitHubIssue).max(INFLIGHT_MAX_ISSUES),
    omitted: z.object({ pulls: count, issues: count }),
    /** Nodes GitHub returned that failed to parse, and were left out. */
    dropped: count,
    /** Changed paths GitHub listed that fail isInflightPath, and were left out. */
    droppedPaths: count.default(0),
  })
  .superRefine((snapshot, ctx) => {
    const numbers = (list: readonly { number: number }[]) =>
      new Set(list.map((x) => x.number)).size;
    if (numbers(snapshot.pulls) !== snapshot.pulls.length)
      ctx.addIssue({
        code: "custom",
        message: "two pull requests share a number",
        path: ["pulls"],
      });
    if (numbers(snapshot.issues) !== snapshot.issues.length)
      ctx.addIssue({ code: "custom", message: "two issues share a number", path: ["issues"] });
  });
export type GitHubSnapshot = z.infer<typeof GitHubSnapshot>;

/** One path segment of a GitHub URL. */
const segment = (text: string): string => encodeURIComponent(text.toWellFormed());

/** A pull request's or an issue's page on GitHub, built from the validated repo and number only. */
export function githubUrl(repo: GitHubRepo, kind: "pull" | "issues", n: number): string {
  return `https://github.com/${segment(repo.owner)}/${segment(repo.name)}/${kind}/${n}`;
}

/** A file's lines at a commit on GitHub: percent-encoded path segments, as the site's code links. */
export function githubBlobUrl(
  repo: GitHubRepo,
  sha: string,
  path: string,
  start: number,
  end: number,
): string {
  const lines = end > start ? `L${start}-L${end}` : `L${start}`;
  const file = path.split("/").map(segment).join("/");
  return `https://github.com/${segment(repo.owner)}/${segment(repo.name)}/blob/${sha}/${file}#${lines}`;
}

/** Every feature id a snapshot names, with where. */
function namedFeatures(inflight: InFlight): { id: string; path: (string | number)[] }[] {
  const named: { id: string; path: (string | number)[] }[] = [];
  inflight.pulls.forEach((pull, p) => {
    pull.files.forEach((file, f) => {
      if (file.featureId !== null)
        named.push({ id: file.featureId, path: ["pulls", p, "files", f, "featureId"] });
    });
    pull.features.forEach((feature, f) => {
      named.push({ id: feature.featureId, path: ["pulls", p, "features", f, "featureId"] });
    });
    pull.effects.forEach((effect, e) => {
      named.push({ id: effect.featureId, path: ["pulls", p, "effects", e, "featureId"] });
    });
  });
  inflight.issues.forEach((open, i) => {
    open.features.forEach((evidence, e) => {
      named.push({ id: evidence.featureId, path: ["issues", i, "features", e, "featureId"] });
    });
  });
  return named;
}

/**
 * What makes a snapshot disagree with the export it rides in: a feature id the manifest lacks,
 * and, when the snapshot was derived against the export's own head, an effect on a claim that is
 * not on its feature's current page. A snapshot derived against an older head is allowed (the
 * site shows it as stale, R16). Paths are relative to the snapshot.
 */
export function inflightProblems(
  inflight: InFlight,
  wiki: { head: string; manifest: Manifest; pages: readonly Revision[] },
): { message: string; path: (string | number)[] }[] {
  const known = new Set(wiki.manifest.features.map((f) => f.id));
  const problems = namedFeatures(inflight)
    .filter(({ id }) => !known.has(id))
    .map(({ id, path }) => ({ message: `${id} is not in the manifest`, path }));
  if (inflight.wikiHead !== wiki.head) return problems;
  const pages = new Map(wiki.pages.map((page) => [page.featureId, page]));
  inflight.pulls.forEach((pull, p) => {
    pull.effects.forEach((effect, e) => {
      const page = pages.get(effect.featureId);
      const claims = page?.sections.flatMap((s) => s.claims.map((c) => c.id)) ?? [];
      if (page?.id !== effect.revisionId || !claims.includes(effect.claimId))
        problems.push({
          message: `claim ${effect.claimId} is not on the current page of ${effect.featureId}`,
          path: ["pulls", p, "effects", e],
        });
    });
  });
  return problems;
}
