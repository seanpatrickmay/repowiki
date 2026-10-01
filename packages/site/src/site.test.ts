import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureExport } from "./test-fixtures.ts";
import { type BuiltSite, brokenLinks, buildFixtureSite, htmlFiles, runCli } from "./test-site.ts";

let site: BuiltSite;
beforeAll(() => {
  site = buildFixtureSite(["--repo-url", "https://github.com/acme/demo-repo"]);
}, 120_000);
afterAll(() => site?.cleanup());

describe("site build", () => {
  it("renders the Main Page and a Pagefind index", () => {
    expect(site.read("index.html")).toContain("Welcome to the demo-repo wiki");
    expect(existsSync(join(site.outDir, "pagefind", "pagefind.js"))).toBe(true);
    expect(site.stdout).toMatch(/^built .+ \(\d+ HTML pages\)$/m);
  });

  it("has no same-site links to missing pages or anchors", () => {
    expect(htmlFiles(site.outDir).length).toBeGreaterThan(0);
    // The fixture may have zero internal links; that's legitimate.
    const result = brokenLinks(site.outDir);
    expect(result.broken).toEqual([]);
  });

  it("references no off-site scripts, styles or fonts", () => {
    for (const page of htmlFiles(site.outDir)) {
      // Articles legitimately carry outbound <a href> links to the repo host and cited URLs.
      // The check is for resources the page loads, so anchors are excluded.
      expect(site.read(page)).not.toMatch(
        /<(?!a[\s>])[a-z][^>]*\s(?:src|href)="(?:https?:\/\/|\/\/)/,
      );
    }
  });
});

describe("site build input validation", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "repowiki-site-bad-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("fails loudly on an export that violates the schema, and writes nothing", () => {
    const bad = { ...fixtureExport(), head: "not-a-sha" };
    writeFileSync(join(dir, "export.json"), JSON.stringify(bad));
    const result = runCli(["build", "--export", dir, "--out", join(dir, "out")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`invalid export ${join(dir, "export.json")}`);
    expect(result.stderr).toContain("head");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("fails loudly on a missing export", () => {
    const result = runCli(["build", "--export", join(dir, "missing.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read export");
  });

  it("exits 2 with usage on bad arguments", () => {
    const result = runCli(["build"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--export is required");
  }, 30_000);
});

describe("site build directory safety", () => {
  it("refuses when out dir contains the export file", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-site-danger-"));
    try {
      const exportFile = join(dir, "export.json");
      writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
      const result = runCli(["build", "--export", exportFile, "--out", dir]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--out cannot contain");
      // Verify export.json is still there
      expect(existsSync(exportFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a non-empty dir without the marker file", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-site-occupied-"));
    try {
      const exportFile = join(dir, "export.json");
      writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
      const outDir = join(dir, "site");
      mkdirSync(outDir);
      const foreignFile = join(outDir, "important.txt");
      writeFileSync(foreignFile, "do not delete");
      const result = runCli(["build", "--export", exportFile, "--out", outDir]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--out must be empty");
      // Verify the file is still there
      expect(readFileSync(foreignFile, "utf8")).toBe("do not delete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a dir containing .git", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-site-repo-"));
    try {
      const exportFile = join(dir, "export.json");
      writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
      const outDir = join(dir, "site");
      mkdirSync(outDir);
      mkdirSync(join(outDir, ".git"));
      const result = runCli(["build", "--export", exportFile, "--out", outDir]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(".git");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("allows a rebuild into a previous site dir with the marker", () => {
    const site = buildFixtureSite();
    try {
      // Mark it
      writeFileSync(join(site.outDir, ".repowiki-site"), "");
      // Rebuild into the same dir
      const result = runCli([
        "build",
        "--export",
        join(site.dir, "export.json"),
        "--out",
        site.outDir,
      ]);
      expect(result.status).toBe(0);
      expect(existsSync(join(site.outDir, ".repowiki-site"))).toBe(true);
    } finally {
      site.cleanup();
    }
  }, 120_000);

  it("succeeds with a non-existent out dir and writes the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-site-new-"));
    try {
      const exportFile = join(dir, "export.json");
      writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
      const outDir = join(dir, "nonexistent", "nested", "site");
      const result = runCli(["build", "--export", exportFile, "--out", outDir]);
      expect(result.status).toBe(0);
      expect(existsSync(join(outDir, "index.html"))).toBe(true);
      expect(existsSync(join(outDir, ".repowiki-site"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("succeeds with an empty existing out dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-site-empty-"));
    try {
      const exportFile = join(dir, "export.json");
      writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
      const outDir = join(dir, "site");
      mkdirSync(outDir);
      const result = runCli(["build", "--export", exportFile, "--out", outDir]);
      expect(result.status).toBe(0);
      expect(existsSync(join(outDir, "index.html"))).toBe(true);
      expect(existsSync(join(outDir, ".repowiki-site"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("succeeds with the default out dir (no --out argument)", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-site-default-"));
    try {
      const exportFile = join(dir, "export.json");
      writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
      // No --out argument means it defaults to <export dir>/site
      const result = runCli(["build", "--export", exportFile]);
      expect(result.status).toBe(0);
      const defaultOutDir = join(dir, "site");
      expect(existsSync(join(defaultOutDir, "index.html"))).toBe(true);
      expect(existsSync(join(defaultOutDir, ".repowiki-site"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("link crawl", () => {
  it("detects good and broken links in a site with links", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-site-links-"));
    try {
      const outDir = join(dir, "site");
      mkdirSync(outDir);
      // Page 1: good page link, broken page link, good same-page anchor, broken same-page anchor
      mkdirSync(join(outDir, "page1"));
      writeFileSync(
        join(outDir, "page1", "index.html"),
        `<html><body id="top">
          <a href="/page2/">good page</a>
          <a href="/missing/">broken page</a>
          <a href="#section">good anchor</a>
          <a href="#missing-section">broken anchor</a>
          <div id="section">Section</div>
        </body></html>`,
      );
      // Page 2: good cross-page anchor, broken cross-page anchor
      mkdirSync(join(outDir, "page2"));
      writeFileSync(
        join(outDir, "page2", "index.html"),
        `<html><body>
          <div id="target">Target</div>
          <a href="/page1/#section">good cross-page anchor</a>
          <a href="/page1/#broken-cross">broken cross-page anchor</a>
        </body></html>`,
      );
      const result = brokenLinks(outDir);
      expect(result.broken).toContain("page1/index.html -> /missing/");
      expect(result.broken).toContain("page1/index.html -> #missing-section");
      expect(result.broken).toContain("page2/index.html -> /page1/#broken-cross");
      expect(result.broken.length).toBe(3);
      expect(result.checked).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe(".astro dir confinement", () => {
  it("does not leave .astro in the spawn cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-site-dirs-"));
    const cliCwd = mkdtempSync(join(tmpdir(), "repowiki-cli-cwd-"));
    try {
      const exportFile = join(dir, "export.json");
      writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
      const outDir = join(dir, "site");
      // Spawn CLI in a different cwd
      const result = runCli(["build", "--export", exportFile, "--out", outDir], cliCwd);
      expect(result.status).toBe(0);
      // .astro should NOT exist in the CLI's spawn cwd
      expect(existsSync(join(cliCwd, ".astro"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cliCwd, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("page shell", () => {
  it("links one local stylesheet with dark-mode, phone-width, and overflow rules", () => {
    const html = site.read("index.html");
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="(\/_astro\/[^"]+\.css)"/g)];
    expect(sheets).toHaveLength(1);
    const css = site.read(sheets[0]?.[1] ?? "");
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toMatch(/max-width:720px|width<=720px/);
    expect(css).toContain("overflow-wrap:anywhere");
  });

  it("has a skip link, a labelled site nav and a main landmark", () => {
    const html = site.read("index.html");
    expect(html).toContain('<a class="skip-link" href="#content">Jump to content</a>');
    expect(html).toContain('<nav class="site-nav" aria-label="Site">');
    expect(html).toContain('<main id="content" class="content">');
    expect(html).toContain("<title>Main page - demo-repo wiki</title>");
  });

  it("uses data: favicon and has no off-site links", () => {
    const html = site.read("index.html");
    expect(html).toContain('<link rel="icon" href="data:,">');
    expect(html).not.toMatch(/(?:src|href)="(?:https?:\/\/|\/\/)/);
  });
});

/** Hashed asset names change with any CSS or script edit; snapshots should not. */
function normalized(path: string): string {
  return site.read(path).replace(/\/_astro\/[^"]+/g, "/_astro/ASSET");
}

describe("article page", () => {
  it("renders the lead, sections, references and infobox", () => {
    const html = site.read("wiki/signals/index.html");
    expect(html).toContain('<h1 class="page-title">Signal ingestion</h1>');
    expect(html).toContain("<b>Signal ingestion</b> is the subsystem of demo-repo");
    expect(html).toContain(
      '<a class="wikilink" href="/wiki/deliverables/" title="Deliverables" data-preview="deliverables">deliverable records</a>',
    );
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Exponential_backoff"');
    expect(html).toContain('<li id="cite-note-5">');
    expect(html).toContain(
      "/blob/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/src/signals/odd%20name%231.py#L1-L9",
    );
    expect(html.match(/This section may be out of date\./g)).toHaveLength(1);
    expect(html).toContain("<td>1,312</td>");
  });

  it("escapes markup in claim text and leaves unknown links as plain text", () => {
    const html = site.read("wiki/signals/index.html");
    expect(html).toContain(
      "<code>&lt;script&gt;</code> tags are stored escaped, and so is &lt;b&gt;this&lt;/b&gt;.",
    );
    expect(html).toContain("The scheduler triggers ingestion");
    expect(html).toContain("ghost described the old approach");
    expect(html).not.toContain("/wiki/ghost/");
  });

  it("indexes current articles for search and marks retired ones", () => {
    expect(site.read("wiki/signals/index.html")).toContain(
      '<article class="article" data-pagefind-body>',
    );
    expect(site.read("wiki/exporter/index.html")).toContain("This feature was retired at commit");
    expect(existsSync(join(site.outDir, "wiki", "scheduler"))).toBe(false);
  });

  it("matches the golden snapshot", async () => {
    await expect(normalized("wiki/signals/index.html")).toMatchFileSnapshot(
      "__snapshots__/wiki-signals.html",
    );
  });
});
