import { z } from "zod";
import { INVISIBLE_CHARACTERS } from "./alias.ts";
import { GitSha, IsoDateTime, RepoPath } from "./primitives.ts";

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

const labels = z.array(line(INFLIGHT_LABEL_MAX_LENGTH)).max(INFLIGHT_MAX_LABELS);

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
  files: z.array(RepoPath).max(INFLIGHT_API_FILES),
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
