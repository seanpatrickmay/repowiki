/**
 * The biography's style sheet (ADR-0013), served at BIOGRAPHY_STYLE_PATH on the pages origin: the
 * site's tokens and the rules the page uses, copied from packages/site/src/styles/wiki.css, plus
 * the hatnote, navbox, categories and infobox image. No page carries inline style.
 */
export const BIOGRAPHY_STYLE = `:root {
  --bg: #ffffff;
  --bg-subtle: #f8f9fa;
  --text: #202122;
  --text-muted: #54595d;
  --border: #a2a9b1;
  --border-subtle: #c8ccd1;
  --link: #3366cc;
  --link-visited: #795cb2;
  --link-external: #3366cc;
  --notice-bg: #fef6e7;
  --notice-border: #fc3;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-serif: "Linux Libertine", Georgia, "Times New Roman", Times, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101418;
    --bg-subtle: #202122;
    --text: #eaecf0;
    --text-muted: #a2a9b1;
    --border: #72777d;
    --border-subtle: #54595d;
    --link: #88a3e8;
    --link-visited: #a799cd;
    --link-external: #88a3e8;
    --notice-bg: #3d2f12;
    --notice-border: #a66200;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html { font-size: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-sans); font-size: 1rem; line-height: 1.6; }
a { color: var(--link); text-decoration: none; }
a:visited { color: var(--link-visited); }
a:hover, .article p a, .article li a { text-decoration: underline; }
a:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
a.external::after { content: " ↗"; font-size: 0.75em; }
code { font-family: var(--font-mono); overflow-wrap: anywhere; background: var(--bg-subtle); border: 1px solid var(--border-subtle); border-radius: 2px; padding: 1px 4px; font-size: 0.875em; }
.preview-banner { background: var(--notice-bg); border-bottom: 1px solid var(--notice-border); padding: 0.4rem 1.5rem; font-size: 0.875rem; text-align: center; }
.site-header { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; min-width: 0; padding: 0.75rem 1.5rem; border-bottom: 1px solid var(--border-subtle); }
.site-name { font-family: var(--font-serif); font-size: 1.5rem; color: var(--text); overflow-wrap: anywhere; }
.site-name:visited { color: var(--text); }
.site-tagline { margin-left: 0.4rem; font-size: 0.9rem; color: var(--text-muted); }
.page { display: flex; max-width: 82rem; margin: 0 auto; }
.site-nav { flex: 0 0 11rem; padding: 1rem 1.5rem; font-size: 0.875rem; }
.site-nav ul { margin: 0; padding: 0; list-style: none; }
.site-nav li { margin: 0.3rem 0; }
.content { flex: 1 1 auto; min-width: 0; padding: 1rem 1.5rem 2rem; }
.page-tabs { display: flex; gap: 1rem; margin-bottom: 0.5rem; font-size: 0.875rem; }
.page-tabs a[aria-current="page"] { color: var(--text); font-weight: 700; }
.page-title { font-family: var(--font-serif); font-size: 1.8rem; font-weight: 400; line-height: 1.3; margin: 0 0 0.25rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--border); }
.tagline { margin: 0 0 1rem; font-size: 0.875rem; color: var(--text-muted); }
.article h2 { font-family: var(--font-serif); font-size: 1.6rem; font-weight: 400; line-height: 1.3; margin: 1.5rem 0 0.5rem; border-bottom: 1px solid var(--border-subtle); }
.article h3 { font-size: 1.2rem; margin: 1.4rem 0 0.3rem; }
.article h4 { font-size: 1rem; margin: 1rem 0 0.2rem; }
.article p { margin: 0.5rem 0; }
.infobox { float: right; clear: right; width: 22rem; margin: 0 0 1rem 1.5rem; border: 1px solid var(--border); background: var(--bg-subtle); border-collapse: collapse; font-size: 0.875rem; line-height: 1.5; }
.infobox caption { caption-side: top; padding: 0.4rem; font-size: 1.25rem; font-weight: 700; }
.infobox th, .infobox td { padding: 0.25rem 0.5rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.infobox th { width: 40%; }
.infobox-image { text-align: center; padding: 0.5rem; }
.infobox-image img { max-width: 100%; height: auto; border-radius: 2px; }
.infobox-caption { font-size: 0.8rem; color: var(--text-muted); }
.toc { display: inline-block; min-width: 14rem; margin: 1rem 0; padding: 0.5rem 1rem; border: 1px solid var(--border); background: var(--bg-subtle); font-size: 0.875rem; }
.toc h2 { font-family: var(--font-sans); font-size: 1rem; font-weight: 700; text-align: center; margin: 0; border: 0; }
.toc ol { margin: 0.25rem 0 0; padding-left: 1.5rem; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.wikitable { border-collapse: collapse; margin: 0.5rem 0 1rem; font-size: 0.9rem; background: var(--bg-subtle); }
.wikitable caption { font-weight: 700; padding: 0.3rem; }
.wikitable th, .wikitable td { border: 1px solid var(--border); padding: 0.3rem 0.55rem; text-align: left; vertical-align: top; }
.wikitable th { background: var(--bg); }
.wikitable td.num { text-align: right; font-variant-numeric: tabular-nums; }
.hatnote { font-style: italic; padding-left: 1.6em; margin: 0.2rem 0 0.6rem; }
.hatnote a { font-style: normal; font-weight: 600; }
.hat-meta { color: var(--text-muted); font-style: normal; font-size: 0.85em; }
.generated-label { color: var(--text-muted); font-size: 0.8rem; }
sup.reference { font-size: 0.75em; line-height: 1; white-space: nowrap; }
.references { font-size: 0.875rem; }
.references li:target { background: var(--bg-subtle); }
.ref-backs { user-select: none; }
.navbox { width: 100%; margin: 1.5rem 0 0.5rem; border: 1px solid var(--border); border-collapse: collapse; font-size: 0.88rem; clear: both; }
.navbox th[scope="col"] { background: var(--bg-subtle); padding: 0.35rem; text-align: center; border-bottom: 1px solid var(--border); }
.navbox td, .navbox th[scope="row"] { padding: 0.3rem 0.6rem; border-top: 1px solid var(--border-subtle); }
.navbox .navbox-group { background: var(--bg-subtle); font-weight: 600; white-space: nowrap; text-align: right; width: 1%; }
.catlinks { margin-top: 1rem; padding: 0.35rem 0.6rem; border: 1px solid var(--border); background: var(--bg-subtle); font-size: 0.85rem; }
.catlinks ul { display: inline; margin: 0; padding: 0; list-style: none; }
.catlinks li { display: inline; }
.catlinks li + li::before { content: " · "; }
.site-footer { padding: 1rem 1.5rem; border-top: 1px solid var(--border-subtle); font-size: 0.75rem; color: var(--text-muted); overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .page { display: block; }
  .site-nav { padding: 0.5rem 1rem; border-bottom: 1px solid var(--border-subtle); }
  .site-nav ul { display: flex; flex-wrap: wrap; gap: 0 1rem; }
  .content { padding: 0.75rem 1rem 2rem; }
  .infobox { float: none; width: 100%; max-width: 100%; margin: 0 0 1rem; }
  .site-header { padding: 0.75rem 1rem; }
}
`;

export const BIOGRAPHY_STYLE_PATH = "/_app/biography.css";

/** The avatar shown when the account has none stored (ADR-0013): a neutral silhouette. */
export const SILHOUETTE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220" width="220" height="220"><rect width="220" height="220" fill="#c8ccd1"/><circle cx="110" cy="84" r="42" fill="#f8f9fa"/><path d="M30 220c0-50 36-82 80-82s80 32 80 82z" fill="#f8f9fa"/></svg>`;
export const SILHOUETTE_PATH = "/_app/avatar.svg";
