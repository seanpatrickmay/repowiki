import { WikiExport } from "@repowiki/core";
import type { DraftRevision, Generation } from "@repowiki/hosted";
import {
  fixtureExport,
  HOSTILE_ARCHITECTURE_TITLE,
  hostileArchitectureExport,
} from "@repowiki/site/test-fixtures";
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../pages/layout.ts";
import { PUBLIC_STYLE_PATH } from "../pages/public-style.ts";
import { hostedExport } from "./hosted-export.ts";
import { CHECKED_STATEMENT, PortfolioData, portfolioData, portfolioHtml } from "./portfolio.ts";

const exp = WikiExport.parse(fixtureExport());
const ids = [...new Set(exp.pages.map((p) => p.featureId))];
const SHA = "c".repeat(40);
const generation = {
  id: "00000000-0000-4000-8000-000000000001",
  jobId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  commitSha: SHA,
  exportKey: "exports/x-1.json",
  exportHash: "d".repeat(64),
  suggestions: {
    tagline: "Suggested tagline",
    summary: "Suggested summary.",
    contributionDraft: "Draft.",
    highlightCandidates: [],
  },
  facts: {
    languages: [{ name: "Python", share: 0.75 }],
    indexedFiles: 12,
    featureIds: ids,
    author: { commits: 3, totalCommits: 4, currentLines: 50, totalLines: 100, features: [] },
  },
  engineVersion: "t",
  models: ["claude-haiku-4-5"],
  spentUsdMicros: 0,
  createdAt: "2026-10-14T12:00:00.000Z",
} as Generation;
const revision = {
  projectId: generation.projectId,
  number: 2,
  generationId: generation.id,
  content: {
    tagline: "Suggested tagline",
    summary: "My <summary> & more.",
    contribution: "Ada built it.",
    highlights: [{ featureId: ids[0] ?? "", blurb: "The core." }],
  },
  createdAt: "2026-10-14T12:00:00.000Z",
} as DraftRevision;
const data = portfolioData({ generation, revision, exp, repoFullName: "demo-dev/demo-repo" });
const published = (d = data) =>
  portfolioHtml(d, {
    base: "/demo-dev/demo-repo/",
    publishedAt: "2026-10-15T09:00:00.000Z",
    preview: false,
  });

describe("the portfolio layer (Contract §8)", () => {
  it("publishes the revision's generated content and names highlights by title", () => {
    expect(PortfolioData.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({
      title: "Demo Repo",
      tagline: "Suggested tagline",
      summary: "My <summary> & more.",
      contribution: "Ada built it.",
      contributionBy: "generated",
      repo: { fullName: "demo-dev/demo-repo", commitSha: SHA },
      highlights: [{ featureId: ids[0], blurb: "The core." }],
    });
  });

  it("names a feature the author touched by its title (§8)", () => {
    const first = ids[0] ?? "";
    const title = exp.manifest.features.find((f) => f.id === first)?.title ?? "";
    expect(title).not.toBe("");
    const touched = {
      ...generation,
      facts: {
        ...generation.facts,
        author: {
          ...generation.facts.author,
          features: [{ featureId: first, commits: 2, currentLines: 9 }],
        },
      },
    } as Generation;
    const d = portfolioData({
      generation: touched,
      revision,
      exp: hostedExport(exp),
      repoFullName: "demo-dev/demo-repo",
    });
    expect(published(d)).toContain(`<dt>${escapeHtml(title)}</dt><dd>2 commits`);
  });

  it("renders the seven parts in order, escaped, with the checked statement verbatim", () => {
    const page = published();
    expect(page).toContain("My &lt;summary&gt; &amp; more.");
    expect(page).not.toContain("<summary>");
    expect(page).toContain(`https://github.com/demo-dev/demo-repo/tree/${SHA}`);
    expect(page).toContain("Author-reviewed");
    expect(page).toContain("Published 2026-10-15");
    expect(page).toContain("3 of 4 commits");
    expect(page).toContain(`/demo-dev/demo-repo/docs/wiki/${ids[0]}/`);
    expect(page).toContain(escapeHtml(CHECKED_STATEMENT(SHA)));
    const order = [
      "<header",
      'id="summary"',
      'id="glance"',
      'id="contribution"',
      'id="highlights"',
      'id="wiki"',
      'id="checked"',
    ];
    const at = order.map((marker) => page.indexOf(marker));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("labels a generated contribution, and never a stored author-written one (ADR-0012)", () => {
    const label = `Generated from the git history at ${SHA.slice(0, 7)}; not written by the author.`;
    expect(published()).toContain(label);
    const { contributionBy: _, ...before } = data;
    const old = PortfolioData.parse(before);
    expect(old.contributionBy).toBe("author");
    expect(published(old)).not.toContain("not written by the author");
  });

  it("uses the public stylesheet and no inline style", () => {
    const page = published();
    expect(page).toContain(`<link rel="stylesheet" href="${PUBLIC_STYLE_PATH}">`);
    expect(page).not.toContain("<style");
    expect(page).not.toContain("style=");
  });

  it("escapes an article title taken from the README", () => {
    const hostile = WikiExport.parse(hostileArchitectureExport());
    const d = portfolioData({
      generation,
      revision,
      exp: hostile,
      repoFullName: "demo-dev/demo-repo",
    });
    expect(d.title).toBe(HOSTILE_ARCHITECTURE_TITLE);
    const page = published(d);
    expect(page).not.toContain("<img");
    expect(page).toContain(escapeHtml(HOSTILE_ARCHITECTURE_TITLE));
  });

  it("says it is a preview, and gives no publish date, before publishing", () => {
    const page = portfolioHtml(data, { base: "/preview/p/2/", publishedAt: null, preview: true });
    expect(page).toContain("Preview: only you can see this page");
    expect(page).toContain("/preview/p/2/docs/");
    expect(page).not.toContain("Published 20");
  });
});
