# 0013. The profile is a generated biography, and the project page goes (F26)

- Status: accepted
- Date: 2026-10-15
- Features: F26
- Amends: ADR-0012 (Content, Origins, Previews); Contract spec D6, §8, §9; spec 2 S13, S14, §7

## Context

ADR-0012 left each published project with its own page (summary, highlights, contribution) at
`/<handle>/<slug>`, its wiki under `/<handle>/<slug>/docs/`, and a profile at `/<handle>` that
listed project cards. Its scope note said a Wikipedia-style biography would replace the project
page. On 2026-10-15 the owner approved a mockup of that biography, built from his own
repositories, and ruled:

1. Two kinds of public page only: the biography at `/<handle>`, and each project's wiki at
   `/<handle>/<slug>/` (its main page, no `/docs/` segment). The project page, its highlights and
   its card go. `/docs/` never launched, so nothing redirects from it.
2. The biography reads as a Wikipedia article: header, title, "From RepoWiki, the developer
   encyclopedia", infobox, a two-paragraph lead, Contents, Works, Career, Technical profile,
   References, External links, a "Projects by" navbox and categories.
3. Every sentence comes from the published projects' data; nothing is hand-written. The voice is
   third person with the surname and never a pronoun.
4. The avatar is the GitHub one, fetched by the server, never loaded from GitHub by a reader.
5. Each wiki links back to its author's biography.

## Decision

Each ruling is "Ruling: X — why — cost if wrong".

### Pages and URLs

- **Two public pages.** Ruling: the pages host serves `/<handle>` (the biography), `/<handle>/` and
  `/<handle>/<slug>` as 301s to `/<handle>` and `/<handle>/<slug>/`, and `/<handle>/<slug>/…` as
  the current version's wiki. The project page route, `portfolioHtml`, `profilePage`, the old
  portfolio style sheet and the "What is checked" statement are removed; `projectUrl` ends in "/".
  An account with no published project answers 404 at `/<handle>`. — A resume link names a person
  or a project's wiki; a third page in between said less than either. — Cost if wrong: a project
  page comes back as a route over the same stored entry.
- **One stored entry per version.** Ruling: a preview or version tree is the built wiki under
  `site/` plus `entry.json`, the project's biography entry (`BiographyEntry` in
  `@repowiki/hosted`): title, repository and commit, first and last commit dates (the earliest and
  latest of the wiki pages' infobox dates, else the export's date), article count, the About
  article's lead as plain text, the generated contribution and the facts. The wiki is built with
  base `/<handle>/<slug>/`. — What the author previewed is still exactly what is published
  (Contract §6.4): the biography's words about a project come only from its hashed tree. — Cost
  if wrong: a new biography field needs a new preview of each project before it shows.
- **Built on request, not stored.** Ruling: the biography is rendered per request from the
  entries of the account's currently published projects (one small object read each), with
  `Cache-Control: public, max-age=60`; there is no server cache and no stored biography snapshot,
  because nothing needs one: every entry is immutable and the page is a pure function of them.
  Unpublish, withdrawal and takedown change the next answer; shared caches may hold the old one
  for up to 60 seconds, as for every public page (S14). — Nothing to invalidate. — Cost if wrong:
  a profile with many projects costs one read per project per uncached request; an in-process
  cache keyed by the published versions is the fix.
- **Versions published before this change.** Ruling: migration 0009 returns every `published`
  project to `draft` (its versions and bytes kept, `currentVersion` unchanged) and deletes every
  preview row and preview token, since their trees have the old layout and no entry. The author
  previews and publishes again; the next version number follows on. — There is no production
  data, and an old tree cannot be rebuilt in SQL. — Cost if wrong: the owner republishes his local
  projects once; `draft` no longer strictly means "never published".

### The biography's text

- **Deterministic templates for this release.** Ruling: every sentence is a template over the
  entries (`biography()` in `@repowiki/hosted`, pure); the only free text is each project's About
  lead (from the engine) and its generated contribution (`generatedContribution`, ADR-0012). It
  costs nothing and every sentence traces to stored facts. A model-written lead may come later,
  as a generation of its own with its own review. — Cost if wrong: the prose reads stiffly; the
  templates are one module.
- **The name.** Ruling: the title is the display name; the surname is its last word. With no
  display name (GitHub's name empty, so the stored display name is the login) both are the
  login. Names are made plain (`plainWords`) before use. — Wikipedia's style, and derivable. —
  Cost if wrong: a name whose family name is not its last word reads oddly; an author-set
  surname would be an author-written field, which ADR-0012 ruled out.
- **No pronouns.** Ruling: the templates never use he, she, they, him, his, her, hers, their or
  them; every reference is the surname. A test runs the templates over many generated inputs and
  rejects any pronoun. The About lead and a model-written contribution are free text outside the
  templates; the model is already asked for the third person and the name. — No pronoun has to be
  guessed. — Cost if wrong: repetitive prose; a model contribution may still say "his", which the
  later model-lead work can forbid in its prompt.
- **Ordering.** Ruling: newest first by the project's last commit everywhere (Works, Career,
  navbox, lead's "other projects"), ties by title. — One order a reader can predict. — Cost if
  wrong: a long-lived project with one recent commit leads.
- **Lead.** Ruling: paragraph 1 is "<b>Name</b> is a software developer and the author of A, <A's
  noun phrase>, and B, <B's noun phrase>." with A and B the top two projects by the author's
  current lines (ties newest first) and a citation to each repository at its commit; the noun
  phrase is the About lead's first sentence without its leading "<Title> is|was|are ", cut by
  `firstClause` at 110 characters, and left out when the sentence does not start that way.
  Paragraph 2 is "<Surname>'s other public projects include X, Y and Z." (only with three or more
  projects) and "Across these N projects <Surname> has made C commits, written mostly in L1, L2
  and L3." (one project: "In this project…"; no languages: no "written" clause). — Rule 5 of the
  owner's brief, generalised. — Cost if wrong: one template.
- **Infobox.** Ruling: avatar captioned "GitHub avatar"; GitHub @login linked; Years active from
  the earliest first commit to the latest last commit, ending "–present" when that last commit is
  within 12 months of the newest publish (in a preview, of now); Known for, the lead's A and B;
  Languages, the top 4 by lines; Projects "N documented"; Commits "N across those projects".
  Nothing is shown that cannot be derived (no occupation). — Cost if wrong: one table.
- **Lines by language.** Ruling: a language's lines are the sum over projects of its share times
  the project's current lines (`facts.languages`, `facts.author.totalLines`); shares are of that
  sum. The Technical profile lists languages with at least 1% of lines, at most 8, each with the
  projects where it is at least 3% (else every project that has it); categories name each
  language with at least 10%, plus "Software developers", as plain text (no category pages
  exist). — Line counts are what the facts hold. — Cost if wrong: counts include co-authors'
  lines; the paragraph says "the code in <Surname>'s documented projects", not "<Surname>'s code".
- **Career periods.** Ruling: a project's year is its first commit's year. The first period is
  the latest such year, headed by the year; every other project falls in "Earlier projects
  (<first>–<last>)" over their years (one year: "Earlier projects (<year>)"). Each opens with one
  sentence listing its projects newest first. Each project is an `h4` with a hatnote "Main
  article: <Title> wiki (N articles, generated from commit `<sha7>`)", the About lead's first two
  sentences cited to the repository at its commit, and the contribution cited to its history at
  that commit, labelled "Generated from the git history at `<sha7>`; not written by the author."
  — Cost if wrong: one grouping function.
- **References.** Ruling: one reference per distinct URL, numbered by first citation, each with a
  "^" backlink per citation (lettered when cited more than once); URLs are
  `https://github.com/<owner>/<repo>/tree/<sha>` and `…/commits/<sha>`. A test checks that every
  marker resolves to a reference and every reference is cited. — Cost if wrong: none beyond the
  renderer.
- **Navbox and links.** Ruling: the navbox "Projects by <Name>" groups by the career periods;
  External links is the GitHub profile; the page ends with "Made with RepoWiki" linking to
  `APP_ORIGIN` (ADR-0012). The site nav lists Works, Career and the GitHub profile; the header's
  "RepoWiki — the developer encyclopedia" links to the biography itself. There is no search box,
  since the pages origin allows no form. — Cost if wrong: copy changes.

### Styling

- **One style sheet on the pages origin.** Ruling: `/_app/biography.css` (replacing
  `/_app/portfolio.css`) holds the site's `:root` light and dark tokens and the rules the page
  uses (header, nav, article, infobox, toc, wikitable, references), copied from the site's CSS,
  plus hatnote, navbox, catlinks and the infobox image. No inline script or style; the pages CSP
  is unchanged. Light and dark follow `prefers-color-scheme` like the wikis; under 720px the
  infobox stops floating and wide tables scroll inside their box. — A biography and its wikis
  look like one encyclopedia. — Cost if wrong: the copy drifts from the site's sheet; a test pins
  the shared tokens to the site's.

### The avatar

- **Fetched at sign-in, served from the pages origin.** Ruling: at sign-in, when GitHub's
  `avatar_url` is an `https://avatars.githubusercontent.com/` URL that differs from the stored
  one, the server fetches it (5-second timeout, no redirects, at most 1 MB read), accepts only
  PNG, JPEG, GIF or WebP by magic bytes, and stores the bytes at `avatars/<sha256>` with the
  account's `avatar` set to `{ sha256, contentType, source }`. A failure keeps the previous
  avatar and never fails the sign-in. The pages host serves `/_app/avatar/<sha256>` with
  `Cache-Control: public, max-age=31536000, immutable` and `nosniff`, only while an active
  account references that hash; with no avatar the biography uses the built-in silhouette at
  `/_app/avatar.svg`. — Readers' browsers never contact GitHub (`img-src 'self'`), and a
  content hash never needs invalidating. — Cost if wrong: a changed avatar shows only after the
  next sign-in; a sign-in is up to five seconds slower when GitHub's avatar host is slow.
- **Local mode.** Ruling: `pnpm hosted:profile` saves the user's avatar beside the snapshot
  (`<snapshot>.avatar`) and records its URL; the local fake GitHub answers that URL with the saved
  bytes, so `hosted:local` stores and shows the real avatar through the same sign-in code. — The
  owner inspects his own page locally. — Cost if wrong: an old snapshot has no avatar and shows the
  silhouette until it is taken again.

### Previews

- **The biography and the wiki, together.** Ruling: `/_preview/<token>/` is the biography as it
  will read once this revision is published: the account's other published projects plus this
  revision's entry in place of the project's current one, with the preview banner; the previewed
  project's links go to `/_preview/<token>/<slug>/`, its wiki, whose own links have
  `/<handle>/<slug>/` rewritten to that path and whose biography link goes back to
  `/_preview/<token>/`. Other projects link to their public wikis. Headers are ADR-0012's. — The
  author reviews what readers will see, both pages. — Cost if wrong: the preview path layout is
  two rewrite rules.

### The wikis and the app

- **Each wiki links to its author.** Ruling: `buildSite` takes an optional `author` (`name`,
  `url`); with it, the site nav gains an entry with the name and the main page's welcome box a line
  "Part of <Name>'s projects", linking to the biography. The hosted build passes it; standalone
  `pnpm wiki:build` and `site:build` sites, without it, are unchanged. — Cost if wrong: a site
  option.
- **The app.** Ruling: the dashboard links "View your profile" to `PUBLIC_ORIGIN/<handle>` once a
  project is published. The project page keeps review, preview and publish, and shows the
  contribution with its label; the revision's content is now only `contribution` (migration 0010
  strips tagline, summary and highlights from stored revisions and deletes their reviews, since
  what the author attested to changed shape). `generatedHighlights` goes. The worker's
  suggestions keep `tagline`, `summary` and `highlightCandidates` for now: they are the stored
  generations' model answer, and the model-written lead will reshape that call. — Cost if wrong:
  three unused suggestion fields until then.

## Consequences

- A resume carries either `repowiki.app/<handle>` or `repowiki.app/<handle>/<slug>/`.
- The runbook's examples of public URLs change (`/<handle>/<slug>/` for a wiki, no `/docs/`), and
  the owner's local projects must be previewed and published again after migration 0009.
- Spec 3 (safe operation) gains the avatar fetch as an outbound request to watch.
