import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WikiExport } from "@repowiki/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExport } from "./load.ts";
import { inflightExport } from "./test-inflight.ts";
import { fixturePeople } from "./test-people.ts";
import { type BuiltSite, brokenLinks, buildFixtureSite, htmlFiles } from "./test-site.ts";

/** The base the owner's GitHub Pages site serves a wiki under (issue #610). */
const BASE = "/wiki/demo/";

/** The fixture with every optional part on: the About article, work in flight and People. */
const fullExport = (): WikiExport =>
  WikiExport.parse({ ...inflightExport(), people: fixturePeople() });

/** Every text file a browser or an agent reads: pages, scripts, styles, data, llms.txt, charts. */
const TEXT = /\.(?:html|js|mjs|css|json|txt|xml|svg)$/;

/** A quote as it can appear around a URL: plain, or as an HTML entity inside an attribute. */
const Q = String.raw`(?:["'\x60]|&quot;|&#34;|&#x22;|&#39;|&#x27;)`;
/** A root-absolute URL: "/" and what follows, up to the end of the quoted or bare value. */
const URL_ = String.raw`(\/[^"'\x60\s<>)&]*)`;

/**
 * The ways a built file can name a same-site URL by its root-absolute path, each with the URL as
 * its first group. External `https://` URLs and `#fragment` links never start with "/", so none
 * of these see them; a protocol-relative `//host` does start with "/", and is caught.
 */
const REFERENCES: { kind: string; pattern: RegExp }[] = [
  {
    kind: "attribute",
    pattern: new RegExp(
      String.raw`\b(?:href|src|srcset|action|formaction|poster)\s*=\s*${Q}?\s*${URL_}`,
      "gi",
    ),
  },
  { kind: "refresh", pattern: new RegExp(String.raw`\burl=\s*${URL_}`, "gi") },
  { kind: "css", pattern: new RegExp(String.raw`url\(\s*["']?\s*${URL_}`, "gi") },
  { kind: "fetch", pattern: new RegExp(String.raw`fetch\(\s*${Q}${URL_}`, "g") },
  {
    kind: "quoted",
    pattern: new RegExp(
      String.raw`${Q}(\/(?:wiki|special|people|api|pagefind|_astro|search|random)\/[^"'\x60\s<>&]*)`,
      "g",
    ),
  },
];

interface Reference {
  file: string;
  kind: string;
  url: string;
}

/**
 * The site's copy of the export it was built from (F07): repository data, whose strings are the
 * repository's text (the alias "/api/signals"), not URLs the site wrote. The scan leaves it out;
 * a test below checks it is the export the build validated, byte for byte.
 */
const EXPORT_COPY = "export.json";

/** Every root-absolute URL reference in every text file under outDir but the export's copy. */
function references(outDir: string): Reference[] {
  const files = (readdirSync(outDir, { recursive: true }) as string[])
    .map((file) => file.split("\\").join("/"))
    .filter((file) => TEXT.test(file) && file !== EXPORT_COPY)
    .sort();
  const found: Reference[] = [];
  for (const file of files) {
    const text = readFileSync(join(outDir, file), "utf8");
    for (const { kind, pattern } of REFERENCES) {
      for (const [, url = ""] of text.matchAll(pattern)) found.push({ file, kind, url });
    }
  }
  return found;
}

let site: BuiltSite;
let found: Reference[];
beforeAll(() => {
  site = buildFixtureSite(
    ["--base", "wiki/demo", "--repo-url", "https://github.com/acme/demo-repo"],
    fullExport(),
  );
  found = references(site.outDir);
}, 120_000);
afterAll(() => site?.cleanup());

describe(`a site built with --base wiki/demo (served under ${BASE})`, () => {
  it("routes every root-absolute URL in every text file through the base", () => {
    const outside = found.filter((ref) => !ref.url.startsWith(BASE));
    expect(outside).toEqual([]);
  });

  it("scans every kind of reference the site writes, so the check above is not vacuous", () => {
    // No stylesheet has a url(), and the bundler renames `fetch` (whose URL the preview script
    // now builds from the page's base), so those two kinds find nothing here today.
    const kinds = new Set(found.map((ref) => ref.kind));
    expect([...kinds].sort()).toEqual(["attribute", "quoted", "refresh"]);
    const files = new Set(found.map((ref) => ref.file.replace(/^_astro\/.*/, "_astro/")));
    for (const file of [
      "index.html",
      "404.html",
      "search/index.html",
      "random/index.html",
      "wiki/signals/index.html",
      "wiki/legacy-signals/index.html",
      "special/about/index.html",
      "special/in-progress/index.html",
      "people/index.html",
      "api/preview/deliverables.json",
      "_astro/",
    ]) {
      expect(files, file).toContain(file);
    }
  });

  it("has no same-site link under the base to a missing page or anchor", () => {
    expect(htmlFiles(site.outDir).length).toBeGreaterThan(0);
    const result = brokenLinks(site.outDir, BASE);
    expect(result.broken).toEqual([]);
    expect(result.checked).toBeGreaterThan(100);
  });

  it("puts the base on every page for the client scripts", () => {
    for (const page of htmlFiles(site.outDir)) {
      expect(site.read(page), page).toContain(`<html lang="en" data-base="${BASE}">`);
    }
  });

  it("loads the Pagefind UI from under the base", () => {
    const search = site.read("search/index.html");
    expect(search).toContain(`<link rel="stylesheet" href="${BASE}pagefind/pagefind-ui.css">`);
    expect(search).toContain(`<script src="${BASE}pagefind/pagefind-ui.js"></script>`);
    expect(site.read("index.html")).toContain(`action="${BASE}search/"`);
  });

  it("serves the export it was built from as it is, so its strings are data", () => {
    const wiki = loadExport(join(site.dir, EXPORT_COPY));
    expect(site.read(EXPORT_COPY)).toBe(`${JSON.stringify(wiki, null, 2)}\n`);
  });

  it("leaves llms.txt's URLs relative to the file, so they resolve under the base", () => {
    const llms = site.read("llms.txt");
    expect(llms).toContain("](wiki/signals/)");
    expect(llms).toContain("](export.json)");
    expect(llms).not.toMatch(/\]\(\//);
  });
});
