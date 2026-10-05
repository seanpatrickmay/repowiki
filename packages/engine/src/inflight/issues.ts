import {
  aliasSlug,
  type GitHubIssue,
  INFLIGHT_EVIDENCE_MAX_LENGTH,
  INFLIGHT_MAX_ISSUE_FEATURES,
  type InFlightFeature,
  type InFlightIssue,
  type IssueEvidence,
  inflightLine,
  type Manifest,
  parseMemberId,
} from "@repowiki/core";

/**
 * Page search over the wiki, as scripts build it from @repowiki/query (C3): the best pages for a
 * text, best first, with their scores. engine never depends on query, so it is passed in.
 */
export type Suggest = (text: string) => readonly { featureId: string; score: number }[];

/** A PR that closes an issue maps it to each feature holding at least this share of its lines. */
export const PULL_SHARE = 0.25;
/** Only the body's first characters are read for paths and names (R12). */
export const BODY_EXCERPT_LENGTH = 2000;
/** A feature id, title or alias shorter than this is never matched as a name. */
export const NAME_MIN_LENGTH = 4;
/** A search hit counts only at this score or above, and this many times the runner-up's. */
export const SEARCH_SCORE_FLOOR = 3;
export const SEARCH_MARGIN = 1.5;

/** Single words too common in issue text to say which feature it means. */
const STOP_NAMES = new Set(
  "data core main test tests util utils code docs type types file files page pages user users api app apps config build tool tools item items list view views".split(
    " ",
  ),
);

/** The pull requests mapIssues reads: what each closes and the features it touches. */
export interface ClosingPull {
  number: number;
  closes: readonly number[];
  features: readonly InFlightFeature[];
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const detail = (text: string): string => inflightLine(text, INFLIGHT_EVIDENCE_MAX_LENGTH);

/** Path-like words of a text, without the sentence punctuation around them. */
function pathTokens(text: string): string[] {
  return (text.match(/[\p{L}\p{N}_.@+~/-]+/gu) ?? []).map((token) =>
    token.replace(/^\.\//, "").replace(/[.,;:!?]+$/, ""),
  );
}

/**
 * Open issues mapped to features (R12), deterministically and with the evidence for each: at most
 * three features, one piece of evidence each, strongest kind first — `pull` (an open PR that
 * closes the issue puts at least PULL_SHARE of its changed lines in the feature), `path` (the
 * title or the body's first BODY_EXCERPT_LENGTH characters name a member file, or a basename only
 * one member file has), `name` (a feature id, title or alias of NAME_MIN_LENGTH or more
 * characters, as a whole phrase), `label` (a label, minus an `area:` or `feature:` prefix, whose
 * slug is a feature id or an alias's slug). An issue none of these maps gets the top `suggest`
 * hit for its title as `search`, kept only at SEARCH_SCORE_FLOOR or above and SEARCH_MARGIN times
 * the runner-up. Only active features are named. Each issue lists the open PRs that close it.
 */
export function mapIssues(
  issues: readonly GitHubIssue[],
  pulls: readonly ClosingPull[],
  manifest: Manifest,
  suggest?: Suggest,
): InFlightIssue[] {
  const active = manifest.features.filter((f) => f.status.kind === "active");
  const activeIds = new Set(active.map((f) => f.id));
  const files = new Map<string, string>();
  const basenames = new Map<string, string[]>();
  for (const [member, { featureId }] of Object.entries(manifest.membership)) {
    const parsed = parseMemberId(member);
    if (parsed === null || parsed.symbol !== null || !activeIds.has(featureId)) continue;
    files.set(parsed.path, featureId);
    const base = parsed.path.slice(parsed.path.lastIndexOf("/") + 1);
    basenames.set(base, [...(basenames.get(base) ?? []), parsed.path]);
  }
  const names = active.flatMap((feature) =>
    [feature.id, feature.title, ...feature.aliases]
      .filter((name) => [...name].length >= NAME_MIN_LENGTH && !STOP_NAMES.has(name.toLowerCase()))
      .map((name) => ({
        featureId: feature.id,
        name,
        pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${literal(name)}(?![\\p{L}\\p{N}_])`, "iu"),
      })),
  );
  const slugs = new Map<string, string>();
  for (const feature of active) {
    slugs.set(feature.id, feature.id);
    for (const alias of feature.aliases) {
      const slug = aliasSlug(alias);
      if (slug !== "" && !slugs.has(slug)) slugs.set(slug, feature.id);
    }
  }

  return issues.map((issue) => {
    const evidence: IssueEvidence[] = [];
    const add = (featureId: string, kind: IssueEvidence["kind"], text: string) => {
      if (evidence.length >= INFLIGHT_MAX_ISSUE_FEATURES) return;
      if (evidence.some((e) => e.featureId === featureId)) return;
      evidence.push({ featureId, kind, detail: detail(text) });
    };
    const closing = pulls.filter((p) => p.closes.includes(issue.number));
    for (const pull of closing) {
      const lines = pull.features.reduce((n, f) => n + f.changedLines, 0);
      const count = pull.features.reduce((n, f) => n + f.files, 0);
      const shares = pull.features
        .map((f) => ({
          id: f.featureId,
          share: lines > 0 ? f.changedLines / lines : f.files / (count || 1),
        }))
        .filter((f) => f.share >= PULL_SHARE && activeIds.has(f.id))
        .sort((a, b) => b.share - a.share);
      for (const { id } of shares) add(id, "pull", `#${pull.number}`);
    }
    const text = `${issue.title}\n${[...issue.body].slice(0, BODY_EXCERPT_LENGTH).join("")}`;
    for (const token of pathTokens(text)) {
      const exact = files.get(token);
      const named = basenames.get(token);
      const path = exact !== undefined ? token : named?.length === 1 ? named[0] : undefined;
      if (path !== undefined) add(files.get(path) as string, "path", path);
    }
    const found = names
      .map((n) => ({ ...n, at: text.search(n.pattern) }))
      .filter((n) => n.at !== -1)
      .sort((a, b) => a.at - b.at);
    for (const n of found) add(n.featureId, "name", n.name);
    for (const label of issue.labels) {
      const featureId = slugs.get(aliasSlug(label.replace(/^(?:area|feature):/i, "")));
      if (featureId !== undefined) add(featureId, "label", label);
    }
    if (evidence.length === 0 && suggest !== undefined) {
      const [top, second] = suggest(issue.title).filter((hit) => activeIds.has(hit.featureId));
      if (
        top !== undefined &&
        top.score >= SEARCH_SCORE_FLOOR &&
        (second === undefined || top.score >= SEARCH_MARGIN * second.score)
      )
        add(top.featureId, "search", `score ${top.score.toFixed(1)}`);
    }
    return {
      number: issue.number,
      title: issue.title,
      author: issue.author,
      labels: issue.labels,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      features: evidence,
      pulls: closing.map((p) => p.number).sort((a, b) => a - b),
    };
  });
}
