import type { Biography, Paragraph } from "@repowiki/hosted";
import { BIOGRAPHY_STYLE_PATH } from "../pages/biography-style.ts";
import { escapeHtml as e } from "../pages/layout.ts";

/** The link from a public page to the app on its own origin (ADR-0012). */
export const madeWith = (appOrigin: string) =>
  `<a href="${e(`${appOrigin}/`)}">Made with RepoWiki</a>`;

/** A citation marker's id: one per use, so each reference can link back to every use. */
const citeId = (n: number, use: number) => `cite-${n}-${use}`;

/** Runs as HTML: every word escaped, links and markers as Wikipedia writes them. */
function runs(paragraph: Paragraph): string {
  return paragraph
    .map((run) => {
      if ("cite" in run) {
        return `<sup class="reference" id="${citeId(run.cite, run.use)}"><a href="#ref-${run.cite}">[${run.cite}]</a></sup>`;
      }
      if ("bold" in run) return `<b>${e(run.bold)}</b>`;
      if ("href" in run) return `<a href="${e(run.href)}">${e(run.text)}</a>`;
      return e(run.text);
    })
    .join("");
}

const BACKLINK_LETTERS = "abcdefghijklmnopqrstuvwxyz";

function infobox(bio: Biography, avatarUrl: string): string {
  const i = bio.infobox;
  const row = (head: string, cell: string) =>
    `<tr><th scope="row">${head}</th><td>${cell}</td></tr>`;
  const known = i.knownFor.map((k) => `<a href="${e(k.href)}">${e(k.title)}</a>`).join("<br>");
  return `<table class="infobox bio"><caption>${e(bio.name)}</caption><tbody>
<tr><td colspan="2" class="infobox-image"><img src="${e(avatarUrl)}" alt="" width="220" height="220"><div class="infobox-caption">GitHub avatar</div></td></tr>
${row("GitHub", `<a class="external" href="${e(i.github.href)}">@${e(i.github.login)}</a>`)}
${row("Years active", e(i.yearsActive))}
${row("Known for", known)}
${i.languages.length === 0 ? "" : row("Languages", e(i.languages.join(", ")))}
${i.technologies.length === 0 ? "" : row("Technologies", e(i.technologies.join(", ")))}
${row("Projects", e(i.projects))}
${row("Commits", e(i.commits))}
</tbody></table>`;
}

function toc(bio: Biography): string {
  const periods = bio.career
    .map((p) => `<li><a href="#${e(p.id)}">${e(p.heading)}</a></li>`)
    .join("");
  return `<nav class="toc" aria-labelledby="toc-heading"><h2 id="toc-heading">Contents</h2><ol>
<li><a href="#works">Works</a></li>
<li><a href="#career">Career</a><ol>${periods}</ol></li>
<li><a href="#technical-profile">Technical profile</a></li>
<li><a href="#references">References</a></li>
<li><a href="#external-links">External links</a></li>
</ol></nav>`;
}

function works(bio: Biography): string {
  const rows = bio.works
    .map(
      (w) =>
        `<tr><td>${e(w.years)}</td><td><a href="${e(w.href)}">${e(w.title)}</a></td><td>${e(w.description)}</td><td>${e(w.languages)}</td><td>${e(w.builtWith)}</td><td class="num">${e(w.commits)}</td><td><a href="${e(w.href)}">Read the wiki</a></td></tr>`,
    )
    .join("\n");
  return `<h2 id="works">Works</h2>
<div class="table-scroll"><table class="wikitable"><caption>Public projects documented by RepoWiki</caption>
<thead><tr><th scope="col">Year</th><th scope="col">Project</th><th scope="col">Description</th><th scope="col">Main languages</th><th scope="col">Built with</th><th scope="col">Commits by ${e(bio.surname)}</th><th scope="col">Wiki</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function career(bio: Biography): string {
  const periods = bio.career.map((period) => {
    const projects = period.projects.map(
      (p) => `<h4 id="project-${e(p.slug)}">${e(p.title)}</h4>
<div class="hatnote" role="note">Main article: <a href="${e(p.href)}">${e(p.title)} wiki</a> <span class="hat-meta">(${p.articles} article${p.articles === 1 ? "" : "s"}, generated from commit <code>${e(p.sha7)}</code>)</span></div>
${p.lead.length === 0 ? "" : `<p>${runs(p.lead)}</p>`}
<p>${runs(p.contribution)}</p>
<p class="generated-label">${e(p.label)}</p>`,
    );
    return `<h3 id="${e(period.id)}">${e(period.heading)}</h3>
<p>${runs(period.intro)}</p>
${projects.join("\n")}`;
  });
  return `<h2 id="career">Career</h2>\n${periods.join("\n")}`;
}

function technical(bio: Biography): string {
  const { paragraph, rows } = bio.technical;
  const table =
    rows.length === 0
      ? ""
      : `<div class="table-scroll"><table class="wikitable"><thead><tr><th scope="col">Language</th><th scope="col">Share of lines</th><th scope="col">Projects</th></tr></thead><tbody>${rows
          .map(
            (r) =>
              `<tr><td>${e(r.language)}</td><td class="num">${e(r.share)}</td><td>${e(r.projects.join(", "))}</td></tr>`,
          )
          .join("")}</tbody></table></div>`;
  return `<h2 id="technical-profile">Technical profile</h2>\n<p>${runs(paragraph)}</p>\n${table}${libraries(bio)}`;
}

/** "Libraries and tools" (ADR-0014): a sentence and a table, each project cited to its evidence. */
function libraries(bio: Biography): string {
  const found = bio.technical.libraries;
  if (found === null) return "";
  const rows = found.rows
    .map((r) => `<tr><td>${e(r.name)}</td><td>${e(r.kind)}</td><td>${runs(r.projects)}</td></tr>`)
    .join("");
  return `
<h3 id="libraries-and-tools">Libraries and tools</h3>
<p>${runs(found.paragraph)}</p>
<div class="table-scroll"><table class="wikitable"><thead><tr><th scope="col">Technology</th><th scope="col">Kind</th><th scope="col">Projects</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function references(bio: Biography): string {
  const items = bio.references.map((ref) => {
    const backs =
      ref.uses === 1
        ? `<a href="#${citeId(ref.n, 0)}" aria-label="Back to the citation">^</a>`
        : `^ ${Array.from(
            { length: ref.uses },
            (_, use) =>
              `<a href="#${citeId(ref.n, use)}"><sup>${BACKLINK_LETTERS[use] ?? use + 1}</sup></a>`,
          ).join(" ")}`;
    return `<li id="ref-${ref.n}"><span class="ref-backs">${backs}</span> <a class="external" href="${e(ref.url)}">${e(ref.label)}</a>. GitHub.</li>`;
  });
  return `<h2 id="references">References</h2>\n<ol class="references">${items.join("\n")}</ol>`;
}

function navbox(bio: Biography): string {
  const rows = bio.navbox
    .map(
      (g) =>
        `<tr><th scope="row" class="navbox-group">${e(g.group)}</th><td>${g.projects
          .map((p) => `<a href="${e(p.href)}">${e(p.title)}</a>`)
          .join(" · ")}</td></tr>`,
    )
    .join("");
  return `<table class="navbox"><tr><th scope="col" colspan="2">Projects by ${e(bio.name)}</th></tr>${rows}</table>`;
}

export interface BiographyOptions {
  /** The biography's own URL (the header and tab link here). */
  self: string;
  avatarUrl: string;
  appOrigin: string;
  /** A preview: a banner says the page is not published. */
  preview: boolean;
  /** The example (ADR-0017): a banner says the person is made up and the code is real. */
  example?: boolean;
}

/** The author's biography page (ADR-0013), in the approved mockup's order; everything escaped. */
export function biographyHtml(bio: Biography, options: BiographyOptions): string {
  const banner = options.preview
    ? `<div class="preview-banner" role="note">Preview: a private link that expires within an hour. This version is not published.</div>`
    : options.example
      ? `<div class="preview-banner" role="note">An example: ${e(bio.name)} is a fictional student. The projects are real code, mirrored on GitHub, and RepoWiki wrote every word. <a href="/">Make your own</a></div>`
      : "";
  const github = bio.infobox.github;
  const categories = bio.categories.map((c) => `<li>${e(c)}</li>`).join("");
  const count = bio.works.length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${e(bio.name)} - RepoWiki</title><link rel="stylesheet" href="${BIOGRAPHY_STYLE_PATH}"></head><body>${banner}
<header class="site-header"><a class="site-name" href="${e(options.self)}">RepoWiki<span class="site-tagline">pages written from code</span></a></header>
<div class="page"><nav class="site-nav" aria-label="Site"><ul><li><a href="#works">Works</a></li><li><a href="#career">Career</a></li><li><a href="${e(github.href)}">GitHub profile</a></li></ul></nav>
<main id="content" class="content"><nav class="page-tabs" aria-label="Page"><a href="${e(options.self)}" aria-current="page">Article</a></nav>
<article class="article">
<h1 class="page-title">${e(bio.name)}</h1><p class="tagline">From RepoWiki. Written by an AI model from public code and git history.</p>
${infobox(bio, options.avatarUrl)}
${bio.lead.map((p) => `<p>${runs(p)}</p>`).join("\n")}
${toc(bio)}
${works(bio)}
${career(bio)}
${technical(bio)}
${references(bio)}
<h2 id="external-links">External links</h2>
<ul><li><a class="external" href="${e(github.href)}">${e(github.login)}</a> on GitHub</li></ul>
${navbox(bio)}
<div class="catlinks"><b>Categories:</b> <ul>${categories}</ul></div>
</article></main></div>
<footer class="site-footer">Generated by RepoWiki from ${count} published project${count === 1 ? "" : "s"}. ${madeWith(options.appOrigin)}</footer>
</body></html>`;
}
