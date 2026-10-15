import { GitSha, type WikiExport } from "@repowiki/core";
import { type DraftRevision, Facts, type Generation } from "@repowiki/hosted";
import { z } from "zod";
import { escapeHtml as e } from "../pages/layout.ts";
import { PUBLIC_STYLE_PATH } from "../pages/public-style.ts";

/** Contract §8 (7), verbatim. */
export const CHECKED_STATEMENT = (sha: string) =>
  `Citations resolve to commit ${sha} with matching content hashes. Whether the cited code supports each claim is not verified automatically.`;

/** The resolved portfolio layer, stored as `portfolio.json` in every preview and version. */
export const PortfolioData = z.strictObject({
  title: z.string().min(1).max(120),
  tagline: z.string().max(90),
  summary: z.string().max(900),
  contribution: z.string().min(1).max(1200),
  repo: z.strictObject({
    fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    commitSha: GitSha,
  }),
  facts: Facts,
  titles: z.record(z.string(), z.string()),
  highlights: z
    .array(z.strictObject({ featureId: z.string(), title: z.string(), blurb: z.string() }))
    .max(4),
  hasAbout: z.boolean(),
});
export type PortfolioData = z.infer<typeof PortfolioData>;

/**
 * The layer a revision publishes (Contract §8): overrides over suggestions, highlight titles from
 * the export, and the facts. `exp` is the hosted export the site is built from, so `hasAbout`
 * matches the built site.
 */
export function portfolioData(input: {
  generation: Generation;
  revision: DraftRevision;
  exp: WikiExport;
  repoFullName: string;
}): PortfolioData {
  const { generation, revision, exp } = input;
  const o = revision.overrides;
  const known = new Set(generation.facts.featureIds);
  const titles = Object.fromEntries(
    exp.manifest.features.filter((f) => known.has(f.id)).map((f) => [f.id, f.title]),
  );
  return PortfolioData.parse({
    title: exp.architecture.at(-1)?.title ?? input.repoFullName.split("/")[1] ?? input.repoFullName,
    tagline: o.tagline ?? generation.suggestions.tagline,
    summary: o.summary ?? generation.suggestions.summary,
    contribution: o.contribution,
    repo: { fullName: input.repoFullName, commitSha: generation.commitSha },
    facts: generation.facts,
    titles,
    highlights: o.highlights.map((h) => ({
      featureId: h.featureId,
      title: titles[h.featureId] ?? h.featureId,
      blurb: h.blurb,
    })),
    hasAbout: exp.architecture.length > 0,
  });
}

const paragraphs = (text: string) =>
  text
    .split(/\n[ \t]*\n/)
    .map((p) => `<p>${e(p.trim())}</p>`)
    .join("");
const percent = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((part / whole) * 100);

/** The public project page (Contract §8), its seven parts in order; `base` ends with "/". */
export function portfolioHtml(
  data: PortfolioData,
  options: { base: string; publishedAt: string | null; preview: boolean },
): string {
  const { facts, repo } = data;
  const docs = `${options.base}docs/`;
  const date =
    options.publishedAt === null
      ? "Not published yet"
      : `Published ${options.publishedAt.slice(0, 10)}`;
  const languages =
    facts.languages.map((l) => `${e(l.name)} ${Math.round(l.share * 100)}%`).join(" · ") || "—";
  const a = facts.author;
  const touched = a.features
    .map(
      (f) =>
        `<dt>${e(data.titles[f.featureId] ?? f.featureId)}</dt><dd>${f.commits} commits · ${f.currentLines} current lines</dd>`,
    )
    .join("");
  const highlights = data.highlights
    .map(
      (h) =>
        `<a href="${e(`${docs}wiki/${h.featureId}/`)}"><strong>${e(h.title)}</strong>${e(h.blurb)}</a>`,
    )
    .join("");
  const repoUrl = `https://github.com/${repo.fullName}/tree/${repo.commitSha}`;
  const about = data.hasAbout
    ? `<dt>Architecture</dt><dd><a href="${e(`${docs}special/about/`)}">How the parts fit together, with the diagram</a></dd>`
    : "";
  const banner = options.preview
    ? `<div class="preview">Preview: only you can see this page</div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(data.title)}</title><meta name="description" content="${e(data.tagline)}"><link rel="stylesheet" href="${PUBLIC_STYLE_PATH}"></head><body>${banner}<main>
<header><h1>${e(data.title)}</h1><p class="tagline">${e(data.tagline)}</p><p class="meta"><a href="${e(repoUrl)}">${e(repo.fullName)} at ${e(repo.commitSha.slice(0, 7))}</a> · ${e(date)}<span class="badge">Author-reviewed</span></p></header>
<section id="summary"><h2>Summary</h2>${paragraphs(data.summary)}</section>
<section id="glance"><h2>At a glance</h2><dl><dt>Languages</dt><dd>${languages}</dd><dt>Size</dt><dd>${facts.indexedFiles} files indexed · ${facts.featureIds.length} features</dd>${about}</dl></section>
<section id="contribution"><h2>My contribution</h2>${paragraphs(data.contribution)}<p class="meta">From the git history at ${e(repo.commitSha.slice(0, 7))}: ${a.commits} of ${a.totalCommits} commits (${percent(a.commits, a.totalCommits)}%) and ${a.currentLines} of ${a.totalLines} current lines (${percent(a.currentLines, a.totalLines)}%).</p>${touched ? `<dl>${touched}</dl>` : ""}</section>
<section id="highlights"><h2>Highlights</h2>${highlights ? `<div class="cards">${highlights}</div>` : `<p class="meta">No highlights chosen.</p>`}</section>
<section id="wiki"><h2>The wiki</h2><p><a href="${e(docs)}">Read the full source-linked wiki</a></p></section>
<section id="checked" class="checked"><h2>What is checked</h2><p>${e(CHECKED_STATEMENT(repo.commitSha))}</p></section>
</main></body></html>`;
}
