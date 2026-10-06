import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderLlmsTxt } from "@repowiki/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "./csp.ts";
import { EXPONENTIAL_BACKOFF, fixtureExport, hostileArchitectureExport } from "./test-fixtures.ts";
import {
  type BuiltSite,
  brokenLinks,
  buildFixtureSite,
  htmlFiles,
  offsiteCssUrls,
  offsiteResources,
  runCli,
} from "./test-site.ts";

let site: BuiltSite;

/** Where the built site keeps a data-preview id's file: Wikipedia ids ("wp:<hash>") have a folder. */
const previewFile = (id: string): string =>
  join(
    site.outDir,
    "api",
    "preview",
    id.startsWith("wp:") ? `wp/${id.slice(3)}.json` : `${id}.json`,
  );
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

  it("serves the wiki's llms.txt and the export it lists at the site's root (F07)", () => {
    const wiki = fixtureExport();
    expect(site.read("llms.txt")).toBe(renderLlmsTxt(wiki));
    expect(site.read("llms.txt")).toContain("- [JSON export](export.json): ");
    expect(JSON.parse(site.read("export.json"))).toEqual(JSON.parse(JSON.stringify(wiki)));
    for (const line of site.read("llms.txt").split("\n")) {
      const page = /\]\(((?:wiki|special)\/[^)]+)\)/.exec(line)?.[1];
      if (page !== undefined) expect(existsSync(join(site.outDir, page, "index.html"))).toBe(true);
    }
  });

  it("has no same-site links to missing pages or anchors", () => {
    expect(htmlFiles(site.outDir).length).toBeGreaterThan(0);
    // The fixture may have zero internal links; that's legitimate.
    const result = brokenLinks(site.outDir);
    expect(result.broken).toEqual([]);
  });

  it("references no off-site scripts, styles or fonts", () => {
    // Outbound <a> links are navigation and exempt; every other loadable URL must be same-site.
    for (const page of htmlFiles(site.outDir)) {
      expect({ page, offsite: offsiteResources(site.read(page)) }).toEqual({ page, offsite: [] });
    }
    const stylesheets = readdirSync(join(site.outDir, "_astro")).filter((f) => f.endsWith(".css"));
    expect(stylesheets.length).toBeGreaterThan(0);
    for (const sheet of stylesheets) {
      expect(offsiteCssUrls(site.read(`_astro/${sheet}`))).toEqual([]);
    }
  });
});

describe("content security policy", () => {
  const CSP =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

  it("is the one constant wiki:serve sends as a header too (C10)", () => {
    expect(CONTENT_SECURITY_POLICY).toBe(CSP);
  });

  it("puts the same policy right after the charset on every page, once", () => {
    const tag = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
    const pages = htmlFiles(site.outDir);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const html = site.read(page);
      expect(html.split("Content-Security-Policy").length - 1, page).toBe(1);
      const afterCharset = html.slice(html.indexOf('<meta charset="utf-8">') + 22);
      expect(afterCharset.trimStart().startsWith(tag), page).toBe(true);
    }
  });

  it("builds without a bundle-size warning", () => {
    expect(site.stderr + site.stdout).not.toMatch(/larger than|chunkSizeWarningLimit/);
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

  it("exits 2 and names the build command when previewing a site that was never built", () => {
    const missing = runCli(["preview", "--out", join(dir, "never-built")]);
    expect(missing.status).toBe(2);
    expect(missing.stderr.trim()).toBe(
      `no built site in ${join(dir, "never-built")}; run \`pnpm site:build --export <file>\` first`,
    );
    mkdirSync(join(dir, "empty"));
    const unmarked = runCli(["preview", "--out", join(dir, "empty")]);
    expect(unmarked.status).toBe(2);
    expect(unmarked.stderr).toContain("pnpm site:build --export");
  }, 30_000);

  it("exits 2 with usage on bad arguments", () => {
    const result = runCli(["build"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--export is required");
  }, 30_000);
});

describe("in-process rebuilds", () => {
  it("renders each buildSite call's own export, even from the same path", () => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-site-twice-"));
    try {
      const exportFile = join(dir, "export.json");
      const second = { ...fixtureExport(), repo: "second-repo" };
      const build = fileURLToPath(new URL("./build.ts", import.meta.url));
      const script = [
        `import { writeFileSync } from "node:fs";`,
        `import { buildSite } from ${JSON.stringify(build)};`,
        `const [file, a, b, next] = process.argv.slice(1);`,
        `await buildSite(file, a, null);`,
        `writeFileSync(file, next);`,
        `await buildSite(file, b, null);`,
      ].join("\n");
      writeFileSync(exportFile, JSON.stringify(fixtureExport()));
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          exportFile,
          join(dir, "a"),
          join(dir, "b"),
          JSON.stringify(second),
        ],
        {
          encoding: "utf8",
          timeout: 220_000,
          cwd: dir,
          env: { ...process.env, NODE_ENV: "production" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const titleOf = (out: string) =>
        /<title>(.*?)<\/title>/.exec(readFileSync(join(dir, out, "index.html"), "utf8"))?.[1];
      expect(titleOf("a")).toBe("Main page - demo-repo wiki");
      expect(titleOf("b")).toBe("Main page - second-repo wiki");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
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

  it("keeps each build's server chunks out of packages/site, so concurrent builds do not race", () => {
    // Astro puts a static build's server chunks in <cwd>/.astro/.prerender when the out dir is
    // outside the cwd; builds that shared packages/site as their cwd overwrote each other's.
    const shared = fileURLToPath(new URL("../.astro/.prerender", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "repowiki-site-race-"));
    rmSync(shared, { recursive: true, force: true });
    mkdirSync(join(shared, ".."), { recursive: true });
    writeFileSync(
      shared,
      "a file where a build that shares packages/site's .astro needs a directory",
    );
    try {
      const exportFile = join(dir, "export.json");
      writeFileSync(exportFile, JSON.stringify(fixtureExport(), null, 2));
      const result = runCli(["build", "--export", exportFile, "--out", join(dir, "site")]);
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(shared, { force: true });
      rmSync(dir, { recursive: true, force: true });
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

  it("underlines links in prose and lists, so they don't rely on colour alone", () => {
    const html = site.read("index.html");
    const sheet = /<link rel="stylesheet" href="(\/_astro\/[^"]+\.css)"/.exec(html)?.[1] ?? "";
    const css = site.read(sheet);
    const underlined = [...css.matchAll(/([^{}]+)\{text-decoration:underline\}/g)].flatMap(
      (match) => (match[1] ?? "").split(","),
    );
    for (const selector of [
      ".article p a",
      ".article section li a",
      ".dab-list a",
      ".redirect-target a",
      ".mp-box p a",
      ".mp-box li a",
    ]) {
      expect(underlined).toContain(selector);
    }
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
    expect(offsiteResources(html)).toEqual([]);
  });
});

/** Hashed asset names change with any CSS or script edit; snapshots should not. */
function normalized(path: string): string {
  return site.read(path).replace(/\/_astro\/[^"]+/g, "/_astro/ASSET");
}

describe("not-found page", () => {
  it("writes a 404.html that points the reader at All articles and search", () => {
    const html = site.read("404.html");
    expect(html).toContain("<title>Page not found - demo-repo wiki</title>");
    expect(html).toContain('<h1 class="page-title">Page not found</h1>');
    expect(html).toContain("There is no article at this address in the demo-repo wiki.");
    expect(html).toContain('<a href="/special/all-pages/">All articles</a>');
    expect(html).toContain('<a href="/search/">search</a>');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain("data-pagefind-body");
  });

  it("is one of the pages the every-page checks cover", () => {
    expect(htmlFiles(site.outDir)).toContain("404.html");
  });
});

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

describe("the Ask sidebar's shell (spec v2 #4 R21)", () => {
  const pages = () => htmlFiles(site.outDir).filter((p) => p !== "special/ask/index.html");

  it("puts a hidden Ask button after the search form, controlling the hidden panel", () => {
    for (const page of pages()) {
      const html = site.read(page);
      const search = html.indexOf('<form class="site-search"');
      const button = html.indexOf('<button type="button" class="ask-button"');
      expect({ page, after: button > search && search >= 0 }).toEqual({ page, after: true });
      expect(html.split("data-ask-open").length - 1, page).toBe(1);
      expect(html, page).toMatch(
        /<button type="button" class="ask-button" aria-expanded="false" aria-controls="ask-panel" data-ask-open hidden>/,
      );
      expect(html, page).toContain(
        '<aside id="ask-panel" class="ask-sidebar" data-pagefind-ignore="all" hidden>',
      );
    }
  });

  it("gives the panel a labelled form, a polite live region and a link to the full page", () => {
    const html = site.read("wiki/signals/index.html");
    expect(html).toContain(
      '<section class="ask" data-ask="sidebar" aria-labelledby="ask-panel-title">',
    );
    expect(html).toContain(
      '<label for="ask-panel-q" class="visually-hidden">Your question</label>',
    );
    expect(html).toContain('<div class="ask-live" aria-live="polite" data-ask-live></div>');
    expect(html).toContain('<div class="ask-result" aria-live="polite" data-ask-result></div>');
    expect(html).toContain('<a href="/special/ask/">Open Ask as a page</a>');
  });

  it("serves /special/ask/ as the panel itself, with no sidebar, out of search", () => {
    const html = site.read("special/ask/index.html");
    expect(html).toContain(
      '<section class="ask" data-ask="page" aria-labelledby="ask-page-title">',
    );
    expect(html).not.toContain("data-ask-open");
    expect(html).not.toContain('id="ask-panel"');
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("ships the ask client in the Layout's script, with no zod in the browser", () => {
    const scripts = readdirSync(join(site.outDir, "_astro")).filter((f) => f.endsWith(".js"));
    const client = scripts
      .map((f) => site.read(`_astro/${f}`))
      .filter((js) => js.includes("/api/ask/status"));
    expect(client).toHaveLength(1);
    expect(client[0]).toContain("/pagefind/pagefind.js");
    expect(client[0]).not.toMatch(/ZodError|\$ZodType/);
  });

  it("covers the viewport under 720px", () => {
    const sheets = readdirSync(join(site.outDir, "_astro")).filter((f) => f.endsWith(".css"));
    const css = sheets.map((f) => site.read(`_astro/${f}`)).join("\n");
    expect(css).toMatch(/@media[^{]*720px[^{]*\{[^@]*\.ask-sidebar\{[^}]*position:\s*fixed/);
  });
});

describe("claim anchors (spec v2 #4 R17)", () => {
  const anchors = (page: string) =>
    [...site.read(page).matchAll(/<span class="claim" id="(claim-[^"]+)">/g)].map((m) => m[1]);

  it("gives every claim of an article, an old revision and the About article its anchor", () => {
    const wiki = fixtureExport();
    const signals = wiki.pages.find((p) => p.featureId === "signals");
    const ids = signals?.sections.flatMap((s) => s.claims.map((c) => `claim-${c.id}`)) ?? [];
    expect(anchors("wiki/signals/index.html")).toEqual(ids);
    expect(anchors("wiki/signals/history/1/index.html").length).toBeGreaterThan(0);
    expect(anchors("special/about/index.html")).toContain("claim-c1");
  });

  it("never repeats an anchor id on a page", () => {
    for (const page of htmlFiles(site.outDir)) {
      const ids = anchors(page);
      expect({ page, repeated: ids.filter((id, i) => ids.indexOf(id) !== i) }).toEqual({
        page,
        repeated: [],
      });
    }
  });
});

describe("hostile fixture content", () => {
  // The fixture feature's title is `<img src=x onerror=alert(1)> "q" & 'p'` plus two private-use
  // characters; its alias is `<i>x</i>`. Titles and labels are plain text, so every page that
  // prints them must escape them. The TOC lists the fixed section titles plus "See also" and
  // "References", never a feature title, so the title reaches the page through the h1, the
  // caption, the browser-tab title and other pages' See also lists.
  const title = "&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;p&#39;\uE000\uE001";

  it("escapes the title, alias and claim text on the article page", () => {
    const html = site.read("wiki/hostile-title/index.html");
    expect(html).toContain(`<h1 class="page-title">${title}</h1>`);
    expect(html).toContain(`<caption>${title}</caption>`);
    expect(html).toContain(`<title>${title} - demo-repo wiki</title>`);
    expect(html).toContain("<td>&lt;i&gt;x&lt;/i&gt;</td>");
    expect(html).toContain("She said &quot;hi&quot; and it&#39;s fine");
    expect(html).toContain('<li><a href="#see-also">See also</a></li>');
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<i>x</i>");
  });

  it("escapes the title in another article's See also list", () => {
    const html = site.read("wiki/deliverables/index.html");
    expect(html).toContain(`<li><a class="wikilink" href="/wiki/hostile-title/">${title}</a></li>`);
  });

  it("emits the hostile markup on no page", () => {
    for (const page of htmlFiles(site.outDir)) {
      expect(site.read(page), page).not.toContain("<img src=x");
    }
  });
});

describe("redirect and disambiguation pages", () => {
  it("redirects a merged feature to its target and names where the reader came from", () => {
    const html = site.read("wiki/legacy-signals/index.html");
    expect(html).toContain(
      '<meta http-equiv="refresh" content="0; url=/wiki/signals/?redirectedfrom=Legacy%20signals">',
    );
    expect(html).toContain('<link rel="canonical" href="/wiki/signals/">');
    expect(html).toMatch(
      /Redirect to:\s*<a class="wikilink" href="\/wiki\/signals\/">Signal ingestion<\/a>/,
    );
    expect(site.read("wiki/signals/index.html")).toContain(
      '<p class="redirect-note" id="redirected-from" hidden></p>',
    );
  });

  it("lists the targets of a split feature with their leads", () => {
    const html = site.read("wiki/reports/index.html");
    expect(html).toContain("<p><b>Reports</b> may refer to:</p>");
    expect(html).toContain('<a class="wikilink" href="/wiki/deliverables/">Deliverables</a>');
    expect(html).toContain(": <b>Deliverables</b> are the records that Signal ingestion feed.");
  });

  it("gives aliases redirect URLs, and a disambiguation page when two features share one", () => {
    expect(site.read("wiki/signals-table/index.html")).toContain(
      "url=/wiki/signals/?redirectedfrom=SIGNALS_TABLE",
    );
    expect(site.read("wiki/api-signals/index.html")).toContain("redirectedfrom=%2Fapi%2Fsignals");
    expect(site.read("wiki/signal-pipeline/index.html")).toContain(
      "<p><b>signal pipeline</b> may refer to:</p>",
    );
  });

  it("links article text to redirect pages instead of dropping the link", () => {
    expect(site.read("wiki/signals/index.html")).toContain(
      'href="/wiki/legacy-signals/" title="Legacy signals" data-preview="legacy-signals">Legacy signals</a>',
    );
  });

  it("escapes a hostile alias on its redirect page and percent-encodes it in the refresh URL", () => {
    const html = site.read("wiki/i-x-i/index.html");
    expect(html).toContain('<h1 class="page-title">&lt;i&gt;x&lt;/i&gt;</h1>');
    expect(html).toContain("<title>&lt;i&gt;x&lt;/i&gt; - demo-repo wiki</title>");
    expect(html).toContain(
      'content="0; url=/wiki/hostile-title/?redirectedfrom=%3Ci%3Ex%3C%2Fi%3E"',
    );
    expect(html).not.toContain("<i>x</i>");
  });

  it("escapes a hostile target title on the redirect page", () => {
    const html = site.read("wiki/i-x-i/index.html");
    expect(html).toMatch(
      /Redirect to:\s*<a class="wikilink" href="\/wiki\/hostile-title\/">&lt;img src=x onerror=alert\(1\)&gt; &quot;q&quot; &amp; &#39;p&#39;\uE000\uE001<\/a>/,
    );
    expect(html).not.toContain("<img src=x");
  });

  it("emits no stray text outside <html> on any page", () => {
    for (const page of htmlFiles(site.outDir)) {
      const html = site.read(page);
      expect(html, page).toMatch(/^<!DOCTYPE html>\n<html /i);
      expect(html.endsWith("</html>"), page).toBe(true);
    }
  });

  it("matches the golden snapshots", async () => {
    await expect(normalized("wiki/legacy-signals/index.html")).toMatchFileSnapshot(
      "__snapshots__/wiki-legacy-signals.html",
    );
    await expect(normalized("wiki/reports/index.html")).toMatchFileSnapshot(
      "__snapshots__/wiki-reports.html",
    );
  });
});

describe("history pages", () => {
  it("lists every revision newest first with prev-diff and old-revision links", () => {
    const html = site.read("wiki/signals/history/index.html");
    expect(html).toContain('<h1 class="page-title">Signal ingestion: Revision history</h1>');
    const second = html.indexOf('href="/wiki/signals/history/2/"');
    const first = html.indexOf('href="/wiki/signals/history/1/"');
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(second);
    expect(html).toContain('(<a href="/wiki/signals/diff/2/">prev</a>)');
    expect(html).toContain("(<span>prev</span>)");
  });

  it("renders old revisions with a banner and keeps them out of search", () => {
    const html = site.read("wiki/signals/history/1/index.html");
    expect(html).toContain("This is an old revision of this page, as of 3 February 2026");
    expect(html).toContain("Signals are built from chunks.");
    expect(html).not.toContain("data-pagefind-body");
  });

  it("diffs a revision against its parent", () => {
    const html = site.read("wiki/signals/diff/2/index.html");
    expect(html).toContain("Signals are <del>built</del><ins>created</ins> from");
    expect(html).toContain('<div class="diff-row diff-added">');
    expect(existsSync(join(site.outDir, "wiki", "signals", "diff", "1"))).toBe(false);
  });

  it("keeps diff pages out of search and points them at the current article", () => {
    const html = site.read("wiki/signals/diff/2/index.html");
    expect(html).not.toContain("data-pagefind-body");
    expect(html).toContain('<link rel="canonical" href="/wiki/signals/">');
    expect(html).toContain('<a href="/wiki/signals/history/" aria-current="page">View history</a>');
    expect(html).toContain('<a href="/wiki/signals/history/1/">Revision as of 3 February 2026</a>');
    expect(html).toContain('<a href="/wiki/signals/history/2/">Revision as of 10 March 2026</a>');
  });

  it("puts the older revision's label before the newer one's", () => {
    const html = site.read("wiki/signals/diff/2/index.html");
    const older = html.indexOf("Revision as of 3 February 2026");
    const newer = html.indexOf("Revision as of 10 March 2026");
    expect(older).toBeGreaterThan(-1);
    expect(newer).toBeGreaterThan(older);
  });

  it("says so when two revisions have the same article text", () => {
    const html = site.read("wiki/deliverables/diff/2/index.html");
    expect(html).toContain("<p>No difference in the article text.</p>");
    expect(html).not.toContain("diff-section");
    expect(html).not.toContain("diff-row");
  });

  it("emits a diff page only for revisions after the first", () => {
    // hostile-title and exporter have one revision each, so they get no diff page.
    for (const feature of ["hostile-title", "exporter", "reports", "scheduler"]) {
      expect(existsSync(join(site.outDir, "wiki", feature, "diff")), feature).toBe(false);
    }
  });

  it("gives every page with history a View history tab, redirects included", () => {
    const article = site.read("wiki/signals/index.html");
    expect(article).toContain('<a href="/wiki/signals/" aria-current="page">Article</a>');
    expect(article).toContain('<a href="/wiki/signals/history/">View history</a>');
    expect(site.read("wiki/signals/history/1/index.html")).toContain(
      '<a href="/wiki/signals/history/" aria-current="page">View history</a>',
    );
    expect(site.read("wiki/legacy-signals/index.html")).toContain(
      '<a href="/wiki/legacy-signals/history/">View history</a>',
    );
    expect(site.read("wiki/legacy-signals/history/index.html")).toContain("Legacy signals");
  });

  it("keeps the retired banner on old revisions of a retired feature", () => {
    const html = site.read("wiki/exporter/history/1/index.html");
    expect(html).toContain("This is the current revision of this page, as of 15 January 2026");
    expect(html).toContain("This feature was retired at commit");
    expect(html.indexOf("This is the current revision")).toBeLessThan(
      html.indexOf("This feature was retired"),
    );
  });

  it("points old revisions at the current article as canonical", () => {
    expect(site.read("wiki/signals/history/1/index.html")).toContain(
      '<link rel="canonical" href="/wiki/signals/">',
    );
    expect(site.read("wiki/signals/index.html")).not.toContain('rel="canonical"');
  });

  it("links history only where a history page exists", () => {
    // `reports` is a disambiguation with no revisions; alias slugs are never feature ids.
    for (const page of ["wiki/reports", "wiki/signal-pipeline", "wiki/i-x-i"]) {
      expect(site.read(`${page}/index.html`), page).not.toContain("View history");
    }
    expect(existsSync(join(site.outDir, "wiki/reports/history/index.html"))).toBe(false);
    expect(existsSync(join(site.outDir, "wiki/scheduler/history/index.html"))).toBe(false);
  });

  it("emits a history page and one old-revision page per revision", () => {
    for (const path of [
      "wiki/signals/history/2/index.html",
      "wiki/exporter/history/1/index.html",
      "wiki/hostile-title/history/1/index.html",
    ]) {
      expect(existsSync(join(site.outDir, path)), path).toBe(true);
    }
    expect(existsSync(join(site.outDir, "wiki/signals/history/3/index.html"))).toBe(false);
  });

  it("links the commit and PR of each revision to the repo", () => {
    const html = site.read("wiki/signals/history/index.html");
    expect(html).toContain(
      `<a class="external" href="https://github.com/acme/demo-repo/pull/88">PR #88</a>`,
    );
    expect(html).toContain(
      `<a class="external" href="https://github.com/acme/demo-repo/commit/${"a".repeat(40)}"><code>aaaaaaa</code></a>`,
    );
    expect(html).toContain("claude-haiku-4-5, 1,200 in / 300 out tokens");
  });

  it("escapes a hostile feature title on its history and old-revision pages", () => {
    const title = "&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;p&#39;\uE000\uE001";
    expect(site.read("wiki/hostile-title/history/index.html")).toContain(
      `<h1 class="page-title">${title}: Revision history</h1>`,
    );
    expect(site.read("wiki/hostile-title/history/1/index.html")).toContain(
      `<title>${title} (old revision) - demo-repo wiki</title>`,
    );
  });

  it("has no broken links from or to the new pages", () => {
    const result = brokenLinks(site.outDir);
    expect(result.broken).toEqual([]);
    expect(result.checked).toBeGreaterThan(0);
  });

  it("matches the golden snapshots", async () => {
    await expect(normalized("wiki/signals/history/index.html")).toMatchFileSnapshot(
      "__snapshots__/wiki-signals-history.html",
    );
    await expect(normalized("wiki/signals/diff/2/index.html")).toMatchFileSnapshot(
      "__snapshots__/wiki-signals-diff-2.html",
    );
  });
});

describe("hover previews", () => {
  const WP_HASH = "bc5383acbe963e3deb31c1ff3a4b9a03";
  /** Every data-preview value on every built page, with the pages that carry it. */
  function previewRequests(): Map<string, string[]> {
    const requests = new Map<string, string[]>();
    for (const page of htmlFiles(site.outDir)) {
      for (const [, id = ""] of site.read(page).matchAll(/data-preview="([^"]*)"/g)) {
        requests.set(id, [...(requests.get(id) ?? []), page]);
      }
    }
    return requests;
  }

  it("writes a preview file for every link that asks for one", () => {
    // Redirect and disambiguation ids get previews of their own, so a link to
    // `legacy-signals` needs no resolving in the page markup.
    const requests = previewRequests();
    expect([...requests.keys()].sort()).toEqual([
      "deliverables",
      "legacy-signals",
      "signals",
      `wp:${WP_HASH}`,
    ]);
    for (const [id, pages] of requests) {
      const file = previewFile(id);
      expect(existsSync(file), `${id} (asked for by ${pages.join(", ")})`).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ url: expect.any(String) });
    }
  });

  it("shows a wp: link's summary card from a file built from the export", () => {
    const html = site.read("wiki/signals/index.html");
    expect(html).toContain(
      `<a class="external" href="https://en.wikipedia.org/wiki/Exponential_backoff" title="Wikipedia: Exponential backoff" data-preview="wp:${WP_HASH}">Exponential backoff</a>`,
    );
    expect(JSON.parse(readFileSync(previewFile(`wp:${WP_HASH}`), "utf8"))).toEqual({
      title: "Exponential backoff",
      url: "https://en.wikipedia.org/wiki/Exponential_backoff",
      html: `<p>${EXPONENTIAL_BACKOFF.extract}</p><p class="preview-facts">From Wikipedia</p>`,
    });
    // One file per Wikipedia title in the export, and no other.
    expect(readdirSync(join(site.outDir, "api", "preview", "wp"))).toEqual([`${WP_HASH}.json`]);
  });

  it("serves the target's lead for a redirect", () => {
    const preview = JSON.parse(site.read("api/preview/legacy-signals.json"));
    expect(preview.title).toBe("Signal ingestion");
    expect(preview.url).toBe("/wiki/signals/");
    expect(preview.html).toContain("<b>Signal ingestion</b> is the subsystem of demo-repo");
  });

  it("serves a disambiguation's targets", () => {
    const preview = JSON.parse(site.read("api/preview/reports.json"));
    expect(preview.html).toBe(
      "<p><b>Reports</b> may refer to: Signal ingestion, Deliverables.</p>",
    );
  });

  it("writes no preview for a feature without a page", () => {
    expect(existsSync(join(site.outDir, "api", "preview", "scheduler.json"))).toBe(false);
  });

  it("loads the preview script exactly once on every page", () => {
    // The Main page has no component scripts, so its one module script is Layout's.
    const scripts = [...site.read("index.html").matchAll(/<script type="module" src="([^"]+)">/g)];
    expect(scripts).toHaveLength(1);
    const layoutScript = `<script type="module" src="${scripts[0]?.[1]}"></script>`;
    expect(layoutScript).toMatch(/src="\/_astro\/[^"]+\.js"/);
    for (const page of htmlFiles(site.outDir)) {
      expect(site.read(page).split(layoutScript).length - 1, page).toBe(1);
    }
  });
});

describe("Main Page, Random article and All articles", () => {
  it("shows the featured article, Did you know hooks and recent updates", () => {
    const html = site.read("index.html");
    // deliverables, hostile-title and signals are the active features with a page.
    expect(html).toContain("3 articles.");
    expect(html).toContain('(<a href="/wiki/deliverables/">Full article...</a>)');
    expect(html).toContain(
      '... that signal ingestion was introduced in PR #45?</span> <span class="dyk-source">(<a href="/wiki/signals/">Signal ingestion</a>)</span>',
    );
    expect(html.indexOf("10 March 2026")).toBeLessThan(html.indexOf("25 February 2026"));
    expect(html.indexOf("25 February 2026")).toBeLessThan(html.indexOf("20 February 2026"));
    expect(html.indexOf("20 February 2026")).toBeLessThan(html.indexOf("15 January 2026"));
  });

  it("escapes the hostile feature's title on the Main Page", () => {
    const html = site.read("index.html");
    const title = "&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;p&#39;\uE000\uE001";
    expect(html).toContain(
      `<li><a href="/wiki/hostile-title/">${title}</a> <span class="mp-date">25 February 2026</span></li>`,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<i>x</i>");
  });

  it("asks for a hover preview only where a preview file exists", () => {
    // The previews test crawls every data-preview on every page; the Main Page must stay in it.
    const html = site.read("index.html");
    for (const [, id = ""] of html.matchAll(/data-preview="([^"]*)"/g)) {
      expect(existsSync(previewFile(id)), id).toBe(true);
    }
  });

  it("sends Random article to one of the active articles", () => {
    expect(site.read("random/index.html")).toContain(
      '<script type="application/json" id="random-targets">["/wiki/deliverables/","/wiki/hostile-title/","/wiki/signals/"]</script>',
    );
  });

  it("lists every routed feature, marking redirects and disambiguations", () => {
    const html = site.read("special/all-pages/index.html");
    expect(html).toContain('<span class="all-pages-note">(redirect to Signal ingestion)</span>');
    expect(html).toContain('<span class="all-pages-note">(disambiguation)</span>');
    expect(html).toContain('<span class="all-pages-note">(retired)</span>');
    expect(html).not.toContain("Scheduler");
  });

  it("escapes the hostile feature's title on All articles", () => {
    const html = site.read("special/all-pages/index.html");
    const title = "&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;p&#39;\uE000\uE001";
    expect(html).toContain(`<a href="/wiki/hostile-title/">${title}</a>`);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<i>x</i>");
  });

  it("links Random article and All articles from every page", () => {
    expect(site.read("wiki/signals/index.html")).toContain('<a href="/random/">Random article</a>');
    for (const page of htmlFiles(site.outDir)) {
      const html = site.read(page);
      expect(html, page).toContain('<a href="/random/">Random article</a>');
      expect(html, page).toContain('<a href="/special/all-pages/">All articles</a>');
    }
  });

  it("crawls the new pages without a broken link", () => {
    const { broken, checked } = brokenLinks(site.outDir);
    expect(broken).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });

  it("matches the golden snapshot", async () => {
    await expect(normalized("index.html")).toMatchFileSnapshot("__snapshots__/index.html");
  });
});

describe("the project's article (About)", () => {
  it("renders its title, lead, sections, diagram and references at /special/about/", () => {
    const html = site.read("special/about/index.html");
    expect(html).toContain("<title>Demo Repo - demo-repo wiki</title>");
    expect(html).toContain('<h1 class="page-title">Demo Repo</h1>');
    const headings = ["Purpose and features", "Layers", "Request paths", "Feature dependencies"];
    for (const heading of [...headings, "References"]) {
      expect(html).toContain(`>${heading}</h2>`);
    }
    expect(html).toContain('<pre class="mermaid">flowchart LR\n  n1[[&quot;Deliverables&quot;]]');
    expect(html).toContain("Deliverables depend on signals &lt;b&gt;and&lt;/b&gt; on ghost.");
    expect(html).not.toContain("<b>and</b>");
    expect(html).not.toContain('content="noindex"');
  });

  it("opens the Main Page with its lead, and is linked from every page's navigation", () => {
    const main = site.read("index.html");
    expect(main).toContain('<h2 id="mp-architecture">About Demo Repo</h2>');
    expect(main.indexOf("mp-architecture")).toBeLessThan(main.indexOf("mp-featured"));
    expect(main).toContain('<p>(<a href="/special/about/">Full article...</a>)</p>');
    for (const page of htmlFiles(site.outDir)) {
      expect(site.read(page), page).toContain(
        '<li><a href="/special/about/">About Demo Repo</a></li>',
      );
    }
  });

  it("matches the golden snapshot", async () => {
    await expect(normalized("special/about/index.html")).toMatchFileSnapshot(
      "__snapshots__/special-about.html",
    );
  });
});

describe("an export without the project's article", () => {
  let bare: BuiltSite;
  beforeAll(() => {
    bare = buildFixtureSite([], { ...fixtureExport(), architecture: [] });
  }, 120_000);
  afterAll(() => bare?.cleanup());

  it("links no page to an About article, and the Main Page has no About box", () => {
    const pages = htmlFiles(bare.outDir);
    expect(pages).toContain("special/about/index.html");
    for (const page of pages) {
      expect(bare.read(page), page).not.toContain('<li><a href="/special/about/">');
    }
    expect(bare.read("index.html")).not.toContain("mp-architecture");
  });

  it("serves /special/about/ as a noindex page that says there is no About article yet", () => {
    const html = bare.read("special/about/index.html");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<h1 class="page-title">About</h1>');
    expect(html).toContain("This wiki has no About article yet.");
    expect(html).not.toContain("data-pagefind-body");
  });
});

describe("a hostile article title", () => {
  // The title is the README's first heading, so it is untrusted: markup, quotes, a wikilink and a
  // fragment. It is plain text on the page <title>, the <h1>, the Main Page box and every page's
  // navigation link, and is never a link or markup.
  const escaped = "&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;p&#39; [[ghost]] #x";
  let hostileSite: BuiltSite;
  beforeAll(() => {
    hostileSite = buildFixtureSite(
      ["--repo-url", "https://github.com/acme/demo-repo"],
      hostileArchitectureExport(),
    );
  }, 120_000);
  afterAll(() => hostileSite?.cleanup());

  it("escapes it in the page title and the h1", () => {
    const html = hostileSite.read("special/about/index.html");
    expect(html).toContain(`<title>${escaped} - demo-repo wiki</title>`);
    expect(html).toContain(`<h1 class="page-title">${escaped}</h1>`);
  });

  it("escapes it in the Main Page box heading", () => {
    const html = hostileSite.read("index.html");
    expect(html).toContain(`<h2 id="mp-architecture">About ${escaped}</h2>`);
  });

  it("escapes it in the navigation link of every page", () => {
    const pages = htmlFiles(hostileSite.outDir);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(hostileSite.read(page), page).toContain(
        `<li><a href="/special/about/">About ${escaped}</a></li>`,
      );
    }
  });

  it("never emits it as markup or as a link", () => {
    for (const page of htmlFiles(hostileSite.outDir)) {
      const html = hostileSite.read(page);
      expect(html, page).not.toContain("<img src=x");
      expect(html, page).not.toContain("onerror=alert(1)>");
      expect(html, page).not.toMatch(/<a [^>]*href="\/wiki\/ghost\//);
      expect(html, page).not.toContain("[[ghost]]</a>");
    }
  });
});

describe("diagrams", () => {
  it("draws the page's diagram at the top of its Data flow section", () => {
    const html = site.read("wiki/signals/index.html");
    const section = html.slice(
      html.indexOf('<h2 id="data-flow">'),
      html.indexOf('<h2 id="history">'),
    );
    expect(section).toContain(
      '<pre class="mermaid">flowchart LR\n  fetch[Fetcher] --&gt; ingest[ingest_chunk]',
    );
    expect(section).toContain("<figcaption>Data flow of Signal ingestion</figcaption>");
    expect(html.split('<pre class="mermaid">').length - 1).toBe(1);
  });

  it("draws the diagram after the lead when the article has no Data flow section", () => {
    const html = site.read("wiki/hostile-title/index.html");
    expect(html).not.toContain('id="data-flow"');
    expect(html.split('<pre class="mermaid">').length - 1).toBe(1);
    expect(html.indexOf('<p class="lead"')).toBeLessThan(html.indexOf('<pre class="mermaid">'));
    expect(html.indexOf('<pre class="mermaid">')).toBeLessThan(html.indexOf('<nav class="toc"'));
  });

  it("escapes diagram source as text, never as markup", () => {
    const html = site.read("wiki/hostile-title/index.html");
    expect(html).toContain(
      '<pre class="mermaid">flowchart LR\n  a[&quot;&lt;img src=x onerror=alert(1)&gt;&quot;] --&gt; b</pre>',
    );
    expect(html).not.toContain("<img src=x");
  });

  it("has no diagram on an article without one", () => {
    expect(site.read("wiki/deliverables/index.html")).not.toContain("mermaid");
  });

  it("draws the feature map on the Main Page", () => {
    expect(site.read("index.html")).toContain("  click n2 &quot;/wiki/signals/&quot;</pre>");
    expect(site.read("index.html")).toContain('<h2 id="mp-map">Feature map</h2>');
  });

  it("joins the map's articles by the project article's calls and imports", () => {
    const html = site.read("index.html");
    expect(html).toContain("  n0 --- n2\n  n1 --- n2\n  click n0");
    expect(html).toContain(
      "<figcaption>Each box is an article; a line joins two articles when code in one calls or imports code in the other.</figcaption>",
    );
  });

  it("keeps the hostile title inside its label in the Main Page's feature map", () => {
    const html = site.read("index.html");
    const block = html.match(/<pre class="mermaid">([\s\S]*?)<\/pre>/)?.[1] ?? "";
    expect(block).toContain(
      "  n1[&quot;#lt;img src#61;x onerror#61;alert#40;1#41;#gt; #quot;q#quot; #amp; #39;p#39;&quot;]",
    );
    expect(block).not.toMatch(/[<>']|&lt;|&#39;|[\uE000-\uF8FF]/);
    expect(html).not.toContain("<img src=x");
  });

  /** The Layout's module script, the only one on the Main Page, as a path inside the build. */
  function layoutScriptPath(): string {
    const entry = site.read("index.html").match(/<script type="module" src="\/(_astro\/[^"]+)"/);
    return entry?.[1] ?? "";
  }

  it("bundles Mermaid locally and loads it only on demand", () => {
    const astro = readdirSync(join(site.outDir, "_astro"));
    expect(astro.some((file) => /^mermaid\.core\..+\.js$/.test(file))).toBe(true);
    const layoutScript = site.read(layoutScriptPath());
    expect(layoutScript).toMatch(/import\(`\.\/mermaid\.core\.[^`]+\.js`\)/);
    // The loader looks for diagrams first, so a page without one never downloads Mermaid.
    expect(layoutScript.indexOf("pre.mermaid")).toBeLessThan(
      layoutScript.indexOf("import(`./mermaid"),
    );
  });

  it("puts the Mermaid loader in the Layout's script once, in strict mode, and nowhere else", () => {
    const layoutPath = layoutScriptPath();
    const layoutScript = site.read(layoutPath);
    const count = (text: string, part: string) => text.split(part).length - 1;
    expect(count(layoutScript, "pre.mermaid")).toBe(1);
    expect(count(layoutScript, "securityLevel:`strict`")).toBe(1);
    expect(layoutScript).not.toMatch(/securityLevel:`(?:loose|antiscript|sandbox)`/);
    // The hover-preview module is in the same script, so Layout's one script tag carries both.
    expect(count(layoutScript, "/api/preview/")).toBe(1);
    const layoutTag = `<script type="module" src="/${layoutPath}"></script>`;
    for (const page of htmlFiles(site.outDir)) {
      const html = site.read(page);
      expect(count(html, layoutTag), page).toBe(1);
      for (const [, src = ""] of html.matchAll(/<script type="module" src="\/([^"]+)"/g)) {
        if (src === layoutPath) continue;
        const other = site.read(src);
        expect(other, `${page} ${src}`).not.toContain("pre.mermaid");
        expect(other, `${page} ${src}`).not.toContain("/api/preview/");
      }
    }
  });

  it("lists no unexpected off-site URL in the built scripts", () => {
    // A heuristic, not the guard: a script can build a URL at run time. The Content-Security-Policy
    // on every page is what actually stops off-site requests; this only makes a Mermaid upgrade
    // that adds a new host or a networking API show up in review.
    const scripts = readdirSync(join(site.outDir, "_astro")).filter((f) => f.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(1);
    // Mermaid 12.0.0's bundle holds other hosts only as inert strings: XML, SVG and Ecore namespace
    // identifiers, and documentation links in error messages. None is fetched. A bare "http://" is
    // a prefix the Markdown parser puts on link text; "http:///org/eclipse/emf/" is an Ecore name.
    const inert = [
      "http://www.w3.org/1998/Math/MathML",
      "http://www.w3.org/1999/xhtml",
      "http://www.w3.org/1999/xlink",
      "http://www.w3.org/2000/svg",
      "http://www.w3.org/2000/xmlns/",
      "http://www.w3.org/2001/XMLSchema#",
      "http://www.w3.org/XML/1998/namespace",
      "http://www.eclipse.org/elk/ElkGraph",
      "http://www.eclipse.org/emf/2002/Ecore",
      "http://www.eclipse.org/emf/2003/XMLType",
      "http:///org/eclipse/emf/",
      "https://chevrotain.io/docs/",
      "https://en.wikipedia.org/wiki/LL_parser#",
      "https://github.com/chevrotain/chevrotain/issues",
      "https://github.com/markedjs/marked.",
      "https://github.com/mermaid-js/mermaid/issues",
      "https://github.com/mermaid-js/mermaid/releases/tag/v11.0.0",
      "https://langium.org/docs/reference/configuration-services/",
      "https://rolldown.rs/in-depth/bundling-cjs",
    ];
    // Absolute http, https, ws and wss URLs, and protocol-relative ones at the start of a string.
    const urls = /(?:https?|wss?):\/\/[^\s`"'<>)\\]*|(?<=[`"'])\/\/[\w.-]+[^\s`"'<>)\\]*/g;
    // Networking APIs and font loading: Mermaid's bundle uses none of them, and neither do we.
    const networking =
      /\b(?:XMLHttpRequest|WebSocket|EventSource|FontFace|importScripts|sendBeacon)\b|@font-face/;
    for (const file of scripts) {
      const text = site.read(`_astro/${file}`);
      const unexpected = (text.match(urls) ?? []).filter(
        (url) => url !== "http://" && url !== "https://" && !inert.some((p) => url.startsWith(p)),
      );
      expect({ file, unexpected }).toEqual({ file, unexpected: [] });
      expect({ file, networking: text.match(networking)?.[0] ?? null }).toEqual({
        file,
        networking: null,
      });
    }
  });
});

describe("search", () => {
  it("puts a labelled search box that submits to /search/ on every page", () => {
    for (const page of htmlFiles(site.outDir)) {
      expect(site.read(page)).toContain(
        '<form class="site-search" role="search" action="/search/" method="get">',
      );
    }
  });

  it("mounts the Pagefind UI from the locally built bundle", () => {
    const html = site.read("search/index.html");
    expect(html).toContain('<link rel="stylesheet" href="/pagefind/pagefind-ui.css">');
    expect(html).toContain('<script src="/pagefind/pagefind-ui.js"></script>');
  });

  it("indexes exactly the current articles of active features and the About article", () => {
    // Only an active feature's current article and the About article carry
    // data-pagefind-body: not history, diff, redirect, disambiguation, the Main Page, /search/
    // itself or a retired article. The retired exporter page still renders with its banner and
    // stays in All articles.
    const indexed = htmlFiles(site.outDir).filter((page) =>
      site.read(page).includes("data-pagefind-body"),
    );
    expect(indexed).toEqual([
      "special/about/index.html",
      "wiki/deliverables/index.html",
      "wiki/hostile-title/index.html",
      "wiki/signals/index.html",
    ]);
    expect(site.read("wiki/exporter/index.html")).toContain("This feature was retired at commit");
    expect(site.read("special/all-pages/index.html")).toContain('href="/wiki/exporter/"');
    const entry = JSON.parse(site.read("pagefind/pagefind-entry.json"));
    expect(entry.languages.en.page_count).toBe(4);
    const body = site.read("wiki/signals/index.html").split("data-pagefind-body")[1] ?? "";
    expect(body).toContain("signal pipeline, SIGNALS_TABLE, /api/signals");
  });

  it("loads the Pagefind UI without an inline script, which the Content-Security-Policy forbids", () => {
    const html = site.read("search/index.html");
    for (const [, attributes = "", body = ""] of html.matchAll(
      /<script([^>]*)>([\s\S]*?)<\/script>/g,
    )) {
      expect(attributes).toMatch(/\ssrc="\/[^"]+"/);
      expect(body).toBe("");
    }
    expect(html).toContain("<noscript>");
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("hands the q parameter only to the Pagefind UI, never to markup or a URL", () => {
    // A tripwire, not a proof: it only catches someone adding an obvious sink to search.ts. The
    // guarantee is Pagefind UI itself, which renders result titles as text nodes and escapes
    // excerpts (checked in a browser with a hostile title and a hostile q).
    const source = readFileSync(new URL("./client/search.ts", import.meta.url), "utf8");
    expect(source).toContain("ui.triggerSearch(query)");
    expect(source).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|location\.(?:href|assign|replace)|\beval\(|new Function|fetch\(/,
    );
  });
});
