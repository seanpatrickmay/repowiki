import { readFileSync } from "node:fs";
import { BiographyEntry, type BiographyProject, biography } from "@repowiki/hosted";
import { describe, expect, it } from "vitest";
import { BIOGRAPHY_STYLE, BIOGRAPHY_STYLE_PATH } from "../pages/biography-style.ts";
import { biographyHtml } from "./biography.ts";

const entry = (title: string, first: string, last: string, sha: string) =>
  BiographyEntry.parse({
    title,
    repo: { fullName: `ada/${title.length}`, commitSha: sha.repeat(40) },
    firstCommitAt: first,
    lastCommitAt: last,
    articles: 3,
    lead: `${title.startsWith("<") ? "It" : title} is a tool that "sorts" mail & more. It runs nightly. It logs.`,
    contribution: "Lovelace wrote 3 of the repository's 4 commits.",
    facts: {
      languages: [{ name: "Python", share: 1 }],
      indexedFiles: 2,
      featureIds: [],
      author: { commits: 3, totalCommits: 4, currentLines: 10, totalLines: 10, features: [] },
    },
    technologies: [
      { id: "fastapi", evidence: { path: "api/<x>.toml" }, importingFiles: 4 },
      { id: "docker", evidence: { path: "Dockerfile" }, importingFiles: null },
    ],
  });
const projects: BiographyProject[] = [
  {
    slug: "a",
    href: "/ada/a/",
    entry: entry("<script>x</script>", "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", "a"),
  },
  {
    slug: "b",
    href: "/ada/b/",
    entry: entry("Beta", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z", "b"),
  },
  {
    slug: "c",
    href: "/ada/c/",
    entry: entry("Gamma", "2026-02-01T00:00:00Z", "2026-04-01T00:00:00Z", "c"),
  },
];
const bio = biography({
  person: { login: "ada", displayName: "Ada <b>Lovelace</b>" },
  projects,
  asOf: "2026-10-15T00:00:00Z",
});
const options = {
  self: "/ada",
  avatarUrl: "/_app/avatar.svg",
  appOrigin: "https://app.repowiki.test",
  preview: false,
};
const page = biographyHtml(bio, options);

describe("biographyHtml (ADR-0013)", () => {
  it("lays the article out in the mockup's order", () => {
    const marks = [
      'class="site-header"',
      'class="page-title"',
      "From RepoWiki, the developer encyclopedia",
      'class="infobox bio"',
      "is a software developer",
      'class="toc"',
      'id="works"',
      'id="career"',
      'id="technical-profile"',
      'id="references"',
      'id="external-links"',
      'class="navbox"',
      'class="catlinks"',
      "Made with RepoWiki",
    ];
    const at = marks.map((m) => page.indexOf(m));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(page).toContain(`<link rel="stylesheet" href="${BIOGRAPHY_STYLE_PATH}">`);
    expect(page).toContain('<img src="/_app/avatar.svg" alt="" width="220" height="220">');
    expect(page).toContain("GitHub avatar");
    expect(page).toContain('href="/ada/b/">Read the wiki</a>');
    expect(page).toContain('Main article: <a href="/ada/c/">Gamma wiki</a>');
  });

  it("escapes every name and generated sentence", () => {
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<b>Lovelace</b>");
    expect(page).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(page).toContain("&quot;sorts&quot; mail &amp; more");
  });

  it("links every citation marker to its reference and back", () => {
    const toRefs = [...page.matchAll(/href="#ref-(\d+)"/g)].map((m) => m[1]);
    const refIds = [...page.matchAll(/<li id="ref-(\d+)"/g)].map((m) => m[1]);
    expect(toRefs.length).toBeGreaterThan(0);
    for (const n of toRefs) expect(refIds).toContain(n);
    for (const n of refIds) expect(toRefs).toContain(n);
    const cites = [...page.matchAll(/<sup class="reference" id="(cite-\d+-\d+)"/g)].map(
      (m) => m[1],
    );
    const backs = [...page.matchAll(/href="#(cite-\d+-\d+)"/g)].map((m) => m[1]);
    expect(new Set(cites)).toEqual(new Set(backs));
    expect(page).toContain(`href="https://github.com/ada/4/tree/${"b".repeat(40)}"`);
  });

  it("carries no script or inline style, and a banner only in a preview", () => {
    expect(page).not.toMatch(/<script|style=/);
    expect(page).not.toContain("preview-banner");
    expect(biographyHtml(bio, { ...options, preview: true })).toContain('class="preview-banner"');
  });
});

/** The custom properties of the first `:root { … }` block after `from` in `css`. */
function tokens(css: string, from = 0): Map<string, string> {
  const start = css.indexOf(":root", from);
  const block = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return new Map(
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1] ?? "",
      (m[2] ?? "").trim(),
    ]),
  );
}

describe("libraries and tools on the biography (ADR-0014)", () => {
  it("adds a Technologies infobox row after Languages", () => {
    expect(page).toMatch(
      /<th scope="row">Languages<\/th><td>Python<\/td><\/tr>\n<tr><th scope="row">Technologies<\/th><td>FastAPI, Docker<\/td><\/tr>/,
    );
  });

  it("adds a Built with column after Main languages, with a dash when there is nothing", () => {
    expect(page).toContain(
      '<th scope="col">Main languages</th><th scope="col">Built with</th><th scope="col">Commits by',
    );
    expect(page).toContain("<td>Python</td><td>FastAPI, Docker</td>");
    const bare = biography({
      person: { login: "ada", displayName: "Ada" },
      projects: projects.map((p) => ({ ...p, entry: { ...p.entry, technologies: [] } })),
      asOf: "2026-10-15T00:00:00Z",
    });
    const plain = biographyHtml(bare, options);
    expect(plain).toContain("<td>Python</td><td>—</td>");
    expect(plain).not.toContain("Libraries and tools");
    expect(plain).not.toContain('<th scope="row">Technologies</th>');
  });

  it("tables them after the languages, cited to the file at the commit", () => {
    const at = (m: string) => page.indexOf(m);
    expect(at("Share of lines")).toBeLessThan(
      at('<h3 id="libraries-and-tools">Libraries and tools</h3>'),
    );
    expect(at("Libraries and tools</h3>")).toBeLessThan(at('id="references"'));
    // The fixture's hostile display name, "Ada <b>Lovelace</b>", leaves the surname "b".
    expect(page).toContain("b&#39;s projects are built most often with FastAPI and Docker.");
    expect(page).toContain(
      '<th scope="col">Technology</th><th scope="col">Kind</th><th scope="col">Projects</th>',
    );
    expect(page).toMatch(
      /<tr><td>FastAPI<\/td><td>Web framework<\/td><td>Gamma<sup class="reference"/,
    );
    expect(page).toContain(
      `href="https://github.com/ada/5/blob/${"c".repeat(40)}/api/%3Cx%3E.toml"`,
    );
    expect(page).toContain(`Gamma: api/&lt;x&gt;.toml at commit ${"c".repeat(7)}`);
    // Docker is a tool: never a category (owner ruling, review).
    expect(page).toContain("<li>FastAPI developers</li></ul>");
  });
});

describe("BIOGRAPHY_STYLE", () => {
  it("runs each section heading below the infobox, as in the mockup (review M2)", () => {
    expect(BIOGRAPHY_STYLE).toContain(".article > h2 { clear: right; }");
  });

  const site = readFileSync(new URL("../../../site/src/styles/wiki.css", import.meta.url), "utf8");
  const dark = (css: string) => tokens(css, css.indexOf("prefers-color-scheme: dark"));

  it("uses the site's light and dark tokens unchanged", () => {
    for (const [mine, theirs] of [
      [tokens(BIOGRAPHY_STYLE), tokens(site)],
      [dark(BIOGRAPHY_STYLE), dark(site)],
    ] as const) {
      expect(mine.size).toBeGreaterThan(10);
      for (const [name, value] of mine) expect([name, value]).toEqual([name, theirs.get(name)]);
    }
  });
});
