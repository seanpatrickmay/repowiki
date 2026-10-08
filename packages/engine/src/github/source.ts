import {
  type Author,
  GITHUB_LOGIN,
  GITHUB_NAME,
  type GitHubIssue,
  type GitHubPull,
  GitHubSnapshot,
  GitSha,
  INFLIGHT_API_FILES,
  INFLIGHT_BRANCH_MAX_LENGTH,
  INFLIGHT_LABEL_MAX_LENGTH,
  INFLIGHT_MAX_CLOSES,
  INFLIGHT_MAX_ISSUES,
  INFLIGHT_MAX_LABELS,
  INFLIGHT_MAX_PULLS,
  INFLIGHT_TITLE_MAX_LENGTH,
  IsoDateTime,
  inflightBody,
  inflightLine,
  isInflightPath,
} from "@repowiki/core";
import { z } from "zod";
import { GH_TIMEOUT_MS, type GhRunner, spawnGh } from "./gh.ts";
import type { GitHubIdentity } from "./identity.ts";
import { redactGitHub } from "./redact.ts";

/** Open pull requests, most recently updated first (spec v2 #9 §5.3). */
export const PULLS_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    isPrivate
    defaultBranchRef { name }
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body isDraft createdAt updatedAt
        author { __typename login }
        baseRefName baseRefOid headRefOid
        labels(first: ${INFLIGHT_MAX_LABELS}) { nodes { name } }
        closingIssuesReferences(first: ${INFLIGHT_MAX_CLOSES}) { nodes { number } }
        files(first: ${INFLIGHT_API_FILES}) { totalCount nodes { path } }
      }
    }
  }
}`;

/** Open issues, most recently updated first; pull requests are not in this connection. */
export const ISSUES_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body createdAt updatedAt
        author { __typename login }
        labels(first: ${INFLIGHT_MAX_LABELS}) { nodes { name } }
      }
    }
  }
}`;

const Page = z.object({
  totalCount: z.int().nonnegative(),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(z.unknown()),
});
const PullsAnswer = z.object({
  data: z.object({
    repository: z
      .object({
        isPrivate: z.boolean(),
        defaultBranchRef: z.object({ name: z.string() }).nullable(),
        pullRequests: Page,
      })
      .nullable(),
  }),
});
const IssuesAnswer = z.object({
  data: z.object({ repository: z.object({ issues: Page }).nullable() }),
});

const RawAuthor = z.object({ __typename: z.string(), login: z.string() }).nullable();
const RawLabels = z
  .object({ nodes: z.array(z.object({ name: z.string() }).nullable()) })
  .nullable();
const RawPull = z.object({
  number: z.int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  isDraft: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  author: RawAuthor,
  baseRefName: z.string(),
  /** The base branch's tip (R27); a missing one is null, so the pull request reads as behind. */
  baseRefOid: GitSha.nullable().optional(),
  headRefOid: GitSha,
  labels: RawLabels,
  closingIssuesReferences: z
    .object({ nodes: z.array(z.object({ number: z.int().positive() }).nullable()) })
    .nullable(),
  files: z
    .object({
      totalCount: z.int().nonnegative(),
      nodes: z.array(z.object({ path: z.string() }).nullable()),
    })
    .nullable(),
});
const RawIssue = z.object({
  number: z.int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  author: RawAuthor,
  labels: RawLabels,
});

/** A login as the export may hold it: validated, else null (R13, C8). */
function authorOf(raw: z.infer<typeof RawAuthor>): Author {
  if (raw === null || !GITHUB_LOGIN.test(raw.login)) return null;
  return { login: raw.login, bot: raw.__typename === "Bot", person: null };
}

const titleOf = (title: string): string =>
  inflightLine(title, INFLIGHT_TITLE_MAX_LENGTH) || "(untitled)";

function labelsOf(raw: z.infer<typeof RawLabels>): string[] {
  const names = (raw?.nodes ?? []).flatMap((node) =>
    node === null ? [] : [inflightLine(node.name, INFLIGHT_LABEL_MAX_LENGTH)],
  );
  return [...new Set(names.filter((name) => name !== ""))].slice(0, INFLIGHT_MAX_LABELS);
}

/**
 * A pull request as the snapshot stores it (R13, R19). A path that fails isInflightPath (not
 * repo-relative, over the cap, or holding a control, tab, line-break or bidi character) is dropped
 * and counted through `onDroppedPath`; GitHub's total stands, so the page counts it as not shown.
 */
export function normalisePull(
  raw: z.infer<typeof RawPull>,
  onDroppedPath: () => void = () => {},
): GitHubPull {
  const closes = (raw.closingIssuesReferences?.nodes ?? []).flatMap((n) =>
    n === null ? [] : [n.number],
  );
  const files = (raw.files?.nodes ?? []).flatMap((n) => {
    if (n === null) return [];
    if (isInflightPath(n.path)) return [n.path];
    onDroppedPath();
    return [];
  });
  return {
    number: raw.number,
    title: titleOf(raw.title),
    body: inflightBody(raw.body ?? ""),
    author: authorOf(raw.author),
    draft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    baseRef: inflightLine(raw.baseRefName, INFLIGHT_BRANCH_MAX_LENGTH) || "(unknown)",
    baseRefOid: raw.baseRefOid ?? null,
    headRefOid: raw.headRefOid,
    labels: labelsOf(raw.labels),
    closes: [...new Set(closes)].slice(0, INFLIGHT_MAX_CLOSES),
    files: [...new Set(files)].slice(0, INFLIGHT_API_FILES),
    filesTotal: raw.files?.totalCount ?? files.length,
  };
}

export function normaliseIssue(raw: z.infer<typeof RawIssue>): GitHubIssue {
  return {
    number: raw.number,
    title: titleOf(raw.title),
    body: inflightBody(raw.body ?? ""),
    author: authorOf(raw.author),
    labels: labelsOf(raw.labels),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/** Newest activity first, then the higher number. */
const byActivity = (a: { updatedAt: string; number: number }, b: typeof a) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number;

/**
 * gh's stderr as a skip reason (R25): GitHub tokens redacted first, then its first non-blank line
 * only, neutralised to one plain line (no control or bidi character) and cut to 200 code points.
 */
function firstLine(stderr: string): string {
  const line =
    redactGitHub(stderr)
      .split("\n")
      .find((l) => l.trim() !== "") ?? "";
  return inflightLine(line, 200) || "no message";
}

class Skip extends Error {}

/** One GraphQL call through `gh api`; its parsed JSON, or a Skip that says why not. */
function graphql(
  run: GhRunner,
  query: string,
  identity: GitHubIdentity,
  first: number,
  after: string | null,
): unknown {
  const args = [
    "api",
    "graphql",
    "--hostname",
    "github.com",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${identity.owner}`,
    "-f",
    `name=${identity.name}`,
    "-F",
    `first=${first}`,
    ...(after === null ? [] : ["-f", `after=${after}`]),
  ];
  const out = run(args);
  if (out.failure === "missing") throw new Skip("gh is not installed (no gh on PATH)");
  if (out.failure === "timeout") throw new Skip(`gh took longer than ${GH_TIMEOUT_MS / 1000} s`);
  if (out.failure === "overflow") throw new Skip("GitHub's answer is over 32 MiB");
  if (out.failure !== null) throw new Skip("gh could not be run");
  // No exit status and no spawn error: a signal stopped it.
  if (out.status === null) throw new Skip("gh was stopped before it answered");
  if (out.status === 4) throw new Skip("gh is not logged in to github.com; run gh auth login");
  if (out.status !== 0) throw new Skip(`GitHub refused the query: ${firstLine(out.stderr)}`);
  try {
    return JSON.parse(out.stdout);
  } catch {
    throw new Skip("GitHub's answer is not JSON");
  }
}

/**
 * Pages through one connection until `cap` nodes or the last page, and never past
 * ceil(cap / pageSize) + 1 pages (a cursor that keeps changing must not page for hours);
 * `select` finds the page.
 */
function readConnection(
  run: GhRunner,
  query: string,
  identity: GitHubIdentity,
  pageSize: number,
  cap: number,
  select: (json: unknown) => { page: z.infer<typeof Page>; extra: unknown } | null,
): { nodes: unknown[]; total: number; extra: unknown } {
  const nodes: unknown[] = [];
  let after: string | null = null;
  let total = 0;
  let extra: unknown = null;
  const maxPages = Math.ceil(cap / pageSize) + 1;
  for (let pages = 1; ; pages++) {
    const first = Math.min(pageSize, cap - nodes.length);
    const selected = select(graphql(run, query, identity, first, after));
    if (selected === null)
      throw new Skip(`GitHub has no repository ${identity.owner}/${identity.name} that gh can see`);
    const { page } = selected;
    if (extra === null) extra = selected.extra;
    total = page.totalCount;
    nodes.push(...page.nodes.slice(0, cap - nodes.length));
    // An empty page or a cursor that did not move ends it too: paging never loops forever.
    const cursor = page.pageInfo.endCursor;
    const last = !page.pageInfo.hasNextPage || cursor === null || cursor === after;
    if (nodes.length >= cap || last || page.nodes.length === 0 || pages >= maxPages)
      return { nodes, total, extra };
    after = cursor;
  }
}

export interface GitHubSource {
  /** The repository's open pull requests and issues, or why they could not be read (R3). */
  read(identity: GitHubIdentity): { snapshot: GitHubSnapshot } | { skip: string };
}

/**
 * The GitHub source behind `gh` (R1): two read-only GraphQL queries on github.com, paged up to
 * R19's caps (50 pull requests, 200 issues), parsed with zod at the boundary. A node that fails
 * to parse is dropped and counted; an answer that fails as a whole is a skip.
 */
export function ghSource(options: { run?: GhRunner; now?: () => Date } = {}): GitHubSource {
  const run = options.run ?? spawnGh;
  const now = options.now ?? (() => new Date());
  return {
    read(identity) {
      // An identity built by hand, not by parseGitHubFlag or parseGitHubRemote: a skip, not a crash.
      if (
        !GITHUB_LOGIN.test(identity.owner) ||
        !GITHUB_NAME.test(identity.name) ||
        identity.name === "." ||
        identity.name === ".."
      )
        return {
          skip: `${inflightLine(`${identity.owner}/${identity.name}`, 100)} is not a GitHub owner/name; pass --github owner/name`,
        };
      try {
        const pulls = readConnection(run, PULLS_QUERY, identity, 50, INFLIGHT_MAX_PULLS, (json) => {
          const parsed = PullsAnswer.safeParse(json);
          if (!parsed.success) throw new Skip("GitHub's answer has an unexpected shape");
          const repository = parsed.data.data.repository;
          return repository === null
            ? null
            : {
                page: repository.pullRequests,
                extra: { private: repository.isPrivate, branch: repository.defaultBranchRef?.name },
              };
        });
        const issues = readConnection(
          run,
          ISSUES_QUERY,
          identity,
          100,
          INFLIGHT_MAX_ISSUES,
          (json) => {
            const parsed = IssuesAnswer.safeParse(json);
            if (!parsed.success) throw new Skip("GitHub's answer has an unexpected shape");
            const repository = parsed.data.data.repository;
            return repository === null ? null : { page: repository.issues, extra: null };
          },
        );
        let dropped = 0;
        let droppedPaths = 0;
        // A node that fails to parse is dropped and counted; one GitHub repeats (pages shift as
        // items are updated between calls) is kept once, and normalised (its paths counted) once.
        const keep = <T extends { number: number }, R>(
          nodes: unknown[],
          schema: z.ZodType<T>,
          normalise: (raw: T) => R,
        ): R[] => {
          const kept = new Map<number, R>();
          for (const node of nodes) {
            const parsed = schema.safeParse(node);
            if (!parsed.success) dropped++;
            else if (!kept.has(parsed.data.number))
              kept.set(parsed.data.number, normalise(parsed.data));
          }
          return [...kept.values()];
        };
        const keptPulls = keep(pulls.nodes, RawPull, (raw) =>
          normalisePull(raw, () => droppedPaths++),
        );
        const pullsDropped = dropped;
        const keptIssues = keep(issues.nodes, RawIssue, normaliseIssue);
        const issuesDropped = dropped - pullsDropped;
        const extra = pulls.extra as { private: boolean; branch: string | undefined };
        const snapshot = GitHubSnapshot.parse({
          repo: {
            host: "github.com",
            owner: identity.owner,
            name: identity.name,
            private: extra.private,
            defaultBranch:
              inflightLine(extra.branch ?? "", INFLIGHT_BRANCH_MAX_LENGTH) || "(unknown)",
          },
          fetchedAt: now().toISOString(),
          pulls: keptPulls.sort(byActivity),
          issues: keptIssues.sort(byActivity),
          // Beyond the caps, and any a repeat displaced: GitHub's total less what was read.
          omitted: {
            pulls: Math.max(0, pulls.total - keptPulls.length - pullsDropped),
            issues: Math.max(0, issues.total - keptIssues.length - issuesDropped),
          },
          dropped,
          droppedPaths,
        });
        return { snapshot };
      } catch (error) {
        if (error instanceof Skip) return { skip: error.message };
        throw error;
      }
    },
  };
}
